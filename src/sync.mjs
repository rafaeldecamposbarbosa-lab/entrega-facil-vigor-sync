// Robô de sincronização: Controle de Entrega da Vigor -> Entrega Fácil.
// Você continua importando as NFs no Entrega Fácil; o robô só atualiza o resultado:
//   entregue (+ foto do canhoto), devolução (ocorrência) e reentrega.
// Roda no GitHub Actions. Segredos: VIGOR_USUARIO, VIGOR_SENHA, SUPABASE_URL, SUPABASE_SECRET_KEY.

import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import { VigorClient } from './vigor.mjs';
import { appendFileSync } from 'node:fs';

const DRY_RUN = /^(1|true|sim)$/i.test(process.env.DRY_RUN || '');
const DIAS = Number(process.env.DIAS_JANELA || 5);          // NFs emitidas nos últimos N dias
const BUCKET = 'delivery-proofs';
const FINAL_EF = new Set(['delivered', 'cancelled']);

const SITUACAO = { 0: 'pendente', 1: 'em_andamento', 2: 'entregue', 3: 'devolvida', 4: 'parcial', 5: 'reentrega', 6: 'em_atendimento' };
const label = s => SITUACAO[s] || `situacao_${s}`;

const db = createClient(must('SUPABASE_URL'), must('SUPABASE_SECRET_KEY'), { auth: { persistSession: false } });
const vigor = new VigorClient();

function must(k) { const v = process.env[k]; if (!v) throw new Error(`Secret ${k} não configurado.`); return v; }
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const brDate = d => d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
function parseBr(s) {
  const m = String(s || '').trim().match(/(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
  return m ? `${m[3]}-${m[2]}-${m[1]}T${m[4] || '12'}:${m[5] || '00'}:00-03:00` : null;
}
const nfKey = v => String(v || '').replace(/\D/g, '').replace(/^0+/, '');
const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
async function q(promise, what) { const { data, error } = await promise; if (error) throw new Error(`${what}: ${error.message}`); return data; }

async function main() {
  const stats = { cargas: 0, nfs_encontradas: 0, nfs_atualizadas: 0, canhotos: 0, ocorrencias: 0 };
  const details = { avisos: [], dry_run: DRY_RUN, mudancas: [], entregas_vigor: 0, nfs_vigor: 0 };
  // Testes ("Só simular") ficam registrados como 'vigor-teste' e não alteram nenhuma entrega.
  const runId = (await q(db.from('integration_runs').insert({ source: DRY_RUN ? 'vigor-teste' : 'vigor' }).select('id').single(), 'registro da execução')).id;
  const anotar = (nf, de, para, extra = '') => { if (details.mudancas.length < 300) details.mudancas.push({ nf, de, para, extra }); };

  try {
    log('Entrando no portal da Vigor...');
    await vigor.login(process.env.VIGOR_USUARIO, process.env.VIGOR_SENHA);

    const hoje = new Date();
    const de = brDate(new Date(hoje.getTime() - DIAS * 864e5)), ate = brDate(hoje);
    const cargas = await vigor.listarCargas(de, ate);
    stats.cargas = cargas.length;
    const entregas = cargas.filter(c => !c.CargaCancelada).flatMap(c => (c.Entregas || []).filter(e => !e.Coleta).map(e => ({
      codigo: e.Codigo, situacao: e.Situacao, carga: c.NumeroCarregamento, placa: c.Placas, motorista: c.NomeMotorista,
    })));
    // Mais recentes primeiro: se a NF foi para reentrega, vale a entrega da carga nova.
    entregas.sort((a, b) => b.codigo - a.codigo);
    log(`${cargas.length} cargas, ${entregas.length} entregas (NFs emitidas de ${de} a ${ate}).`);

    // Memória das entregas já vistas (evita consultar o detalhe quando nada mudou).
    const cache = new Map();
    for (const part of chunk(entregas.map(e => e.codigo), 200)) {
      for (const r of await q(db.from('vigor_entregas_cache').select('*').in('codigo', part), 'cache')) cache.set(Number(r.codigo), r);
    }

    // NFs lançadas no Entrega Fácil nos últimos 45 dias.
    const desde = new Date(hoje.getTime() - 45 * 864e5).toISOString();
    const efRows = await q(db.from('deliveries')
      .select('id,invoice_number,status,driver_id,client_id,vigor_entrega_codigo,vigor_situacao,reentrega_count,delivery_proofs(id)')
      .gte('created_at', desde).not('invoice_number', 'is', null).limit(5000), 'entregas do Entrega Fácil');
    const efByNf = new Map();
    for (const r of efRows) { const k = nfKey(r.invoice_number); if (k) (efByNf.get(k) || efByNf.set(k, []).get(k)).push(r); }

    const clientCoordsDone = new Set(), seenRows = new Set();
    for (const e of entregas) {
      let c = cache.get(e.codigo), d = null;
      const getDetail = async () => (d ||= await vigor.detalhesEntrega(e.codigo));
      if (!c || c.situacao !== e.situacao || !c.nfs?.length) {
        try { await getDetail(); } catch (err) { details.avisos.push(`Entrega ${e.codigo} (carga ${e.carga}): ${err.message}`); continue; }
        const nfs = String(d?.NotasFiscais || '').split(/[,;\s]+/).map(nfKey).filter(Boolean);
        c = { codigo: e.codigo, carga: e.carga, placa: e.placa, nfs, situacao: e.situacao, canhotos_nfs: c?.canhotos_nfs || [], updated_at: new Date().toISOString() };
        if (!DRY_RUN) await q(db.from('vigor_entregas_cache').upsert(c), 'salvar cache');
        cache.set(e.codigo, c);
      }
      const matches = c.nfs.flatMap(nf => (efByNf.get(nf) || []).map(row => ({ nf, row })))
        .filter(({ row }) => !seenRows.has(row.id) && !(row.vigor_entrega_codigo && Number(row.vigor_entrega_codigo) > e.codigo));
      matches.forEach(({ row }) => seenRows.add(row.id));
      if (!matches.length) continue;
      stats.nfs_encontradas += matches.length;

      let canhotoList = null;
      for (const { nf, row } of matches) {
        try {
          const evento = [];
          let temProva = (row.delivery_proofs || []).length > 0;

          // 1) Vigor entregou: tenta anexar o canhoto (também nas NFs já concluídas sem foto).
          if (e.situacao === 2 && !temProva && row.status !== 'cancelled') {
            canhotoList ||= await vigor.canhotos(e.codigo);
            const cn = canhotoList.find(x => nfKey(x.nf) === nf && !x.pdf);
            const raw = cn && cn.temImagem ? await vigor.baixarCanhoto(cn.codigo, cn.esperandoVinculo) : null;
            if (!raw) {
              details.canhotos_pendentes = (details.canhotos_pendentes || 0) + 1;
            } else {
              const img = await sharp(raw).rotate().resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 72, mozjpeg: true }).toBuffer();
              const path = `vigor/${row.id}.jpg`;
              if (!DRY_RUN) {
                await q(db.storage.from(BUCKET).upload(path, img, { contentType: 'image/jpeg', upsert: true }), 'upload do canhoto');
                await q(db.from('delivery_proofs').upsert({ delivery_id: row.id, storage_path: path, uploaded_by: row.driver_id,
                  captured_at: parseBr(d?.DataConfirmacao) || new Date().toISOString(), notes: 'Canhoto importado do portal Vigor' }, { onConflict: 'delivery_id' }), 'comprovante');
              }
              row.delivery_proofs = [{ id: 'novo' }];
              temProva = true;
              stats.canhotos++;
              anotar(nf, 'sem canhoto', 'canhoto anexado', `${Math.round(img.length / 1024)} KB`);
            }
          }

          // Entregue na Vigor sem foto: conclui aqui também e continua procurando o canhoto nas próximas rodadas.
          const semFoto = e.situacao === 2 && !temProva;
          const novo = semFoto ? 'entregue_sem_foto' : label(e.situacao);
          const mudou = row.vigor_situacao !== novo || Number(row.vigor_entrega_codigo) !== e.codigo;
          const patch = { vigor_entrega_codigo: e.codigo, vigor_situacao: novo, vigor_synced_at: new Date().toISOString() };

          if (mudou && e.situacao === 2 && !FINAL_EF.has(row.status)) {
            await getDetail();
            Object.assign(patch, {
              status: 'delivered',
              delivered_at: parseBr(d?.DataConfirmacao) || parseBr(d?.DataFim) || parseBr(d?.DataEntregaNota) || new Date().toISOString(),
              delivered_by: row.driver_id,
            });
            const rec = String(d?.DadosRecebedorNome || '').trim();
            evento.push(['Entrega confirmada pelo portal Vigor', `Carga ${e.carga} · ${e.placa}${rec ? ' · recebido por ' + rec : ''}${semFoto ? ' · canhoto ainda não enviado na Vigor' : ''}`]);
          } else if (mudou && (e.situacao === 3 || e.situacao === 5) && ['pending', 'in_progress', 'overdue'].includes(row.status)) {
            await getDetail();
            const oc = (d?.Ocorrencias || [])[0];
            const motivo = [String(d?.InfoMotivoRejeicao || oc?.Descricao || 'Ocorrência').replace(/^"|"$/g, ''), d?.Observacao].filter(Boolean).join(' — ');
            const quando = parseBr(d?.DataRejeitado) || parseBr(oc?.DataOcorrencia) || new Date().toISOString();
            if (e.situacao === 5) {
              Object.assign(patch, { status: 'reentrega', reentrega_requested_at: quando, reentrega_requested_by: row.driver_id,
                reentrega_reason: `Portal Vigor: ${motivo}`.slice(0, 500), reentrega_count: (row.reentrega_count || 0) + 1 });
              evento.push(['Reentrega informada pelo portal Vigor', motivo]);
            } else {
              Object.assign(patch, { status: 'avaria' });
              const tipo = /avari/i.test(motivo) ? 'avaria' : /devol|recus/i.test(motivo) ? 'recusa' : /ausen|fechad/i.test(motivo) ? 'cliente_ausente' : 'outro';
              if (!DRY_RUN) await q(db.from('delivery_incidents').insert({ delivery_id: row.id, type: tipo,
                description: `Portal Vigor — ${motivo}`.slice(0, 1000), reported_by: row.driver_id, created_at: quando }), 'ocorrência');
              stats.ocorrencias++;
              evento.push(['Devolução informada pelo portal Vigor', motivo]);
            }
          }

          // Coordenadas do cliente: usa a posição cadastrada na Vigor quando o Entrega Fácil ainda não tem.
          if (d?.LocalCliente && row.client_id && !clientCoordsDone.has(row.client_id)) {
            const lc = typeof d.LocalCliente === 'string' ? JSON.parse(d.LocalCliente) : d.LocalCliente;
            const lat = Number(lc?.Latitude), lng = Number(lc?.Longitude);
            if (lat && lng && !DRY_RUN) {
              // Ignora coordenada genérica: se o mesmo ponto já pertence a outro cliente, não é a do endereço.
              const dono = await q(db.from('clients').select('id').eq('latitude', lat).eq('longitude', lng).neq('id', row.client_id).limit(1), 'checar coordenada');
              if (!dono.length) {
                await q(db.from('clients').update({ latitude: lat, longitude: lng, coordinates_updated_at: new Date().toISOString(), coordinates_source: 'vigor' })
                  .eq('id', row.client_id).is('latitude', null), 'coordenadas do cliente');
              } else details.avisos.push(`Coordenada da Vigor ignorada (ponto repetido) para o cliente da NF ${nf}`);
            }
            clientCoordsDone.add(row.client_id);
          }

          if (mudou || patch.status) {
            if (!DRY_RUN) {
              await q(db.from('deliveries').update(patch).eq('id', row.id), `atualizar NF ${nf}`);
              for (const [action, det] of evento) await q(db.from('delivery_events').insert({ delivery_id: row.id, action, details: det || '' }), 'histórico');
            }
            if (patch.status) { stats.nfs_atualizadas++; log(`NF ${nf}: ${row.status} -> ${patch.status}`); anotar(nf, row.status, patch.status, evento.map(x => x[1]).filter(Boolean).join(' | ').slice(0, 200)); }
            Object.assign(row, patch);
          }
        } catch (err) {
          // Um problema numa NF não interrompe as demais.
          details.avisos.push(`NF ${nf}: ${err.message}`);
          console.warn(`Aviso NF ${nf}:`, err.message);
        }
      }
    }

    details.entregas_vigor = entregas.length;
    details.nfs_vigor = new Set([...cache.values()].flatMap(c => c.nfs || [])).size;
    log('Resumo:', JSON.stringify(stats), details.avisos.length ? `${details.avisos.length} aviso(s)` : '');
    resumoGitHub(stats, details);
    if (runId) await q(db.from('integration_runs').update({ ...stats, status: 'ok', finished_at: new Date().toISOString(), details }).eq('id', runId), 'finalizar registro');
  } catch (err) {
    console.error('ERRO:', err.message);
    if (runId) await db.from('integration_runs').update({ ...stats, status: 'error', error: err.message.slice(0, 1000), finished_at: new Date().toISOString(), details }).eq('id', runId);
    process.exitCode = 1;
  }
}

function resumoGitHub(stats, details) {
  const f = process.env.GITHUB_STEP_SUMMARY; if (!f) return;
  const linhas = [
    `## ${details.dry_run ? 'Teste (nada foi gravado)' : 'Sincronização concluída'}`,
    `- Cargas no portal: **${stats.cargas}** · entregas: **${details.entregas_vigor}** · NFs na Vigor: **${details.nfs_vigor}**`,
    `- NFs do Entrega Fácil encontradas: **${stats.nfs_encontradas}** · entregues sem foto do canhoto: **${details.canhotos_pendentes || 0}** (o robô anexa a foto quando ela aparecer na Vigor)`,
    `- NFs ${details.dry_run ? 'que seriam atualizadas' : 'atualizadas'}: **${stats.nfs_atualizadas}** · canhotos: **${stats.canhotos}** · ocorrências: **${stats.ocorrencias}**`,
    '', '| NF | antes | depois | detalhe |', '|---|---|---|---|',
    ...details.mudancas.map(m => `| ${m.nf} | ${m.de} | ${m.para} | ${String(m.extra || '').replace(/\|/g, '/')} |`),
    ...(details.avisos.length ? ['', '**Avisos:**', ...details.avisos.map(a => `- ${a}`)] : []),
  ];
  try { appendFileSync(f, linhas.join('\n') + '\n'); } catch {}
}

main();
