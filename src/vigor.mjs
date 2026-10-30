// Cliente do portal MultiTMS da Vigor (somente leitura).
// Faz login com usuário/senha e consulta os mesmos endereços que a tela
// "Cargas > Controle Entrega" usa.

const BASE = process.env.VIGOR_URL || 'https://vigor.multitransportador.com.br';
const UA = 'Mozilla/5.0 (EntregaFacil-VigorSync/1.0)';

export class VigorClient {
  constructor() { this.cookies = new Map(); }

  #cookieHeader() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
  #storeCookies(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of list) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  async #request(path, { method = 'GET', form, accept = 'application/json', redirect = 'manual' } = {}) {
    const headers = { 'User-Agent': UA, 'Cookie': this.#cookieHeader(), 'Accept': accept };
    let body;
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      headers['X-Requested-With'] = 'XMLHttpRequest';
      body = new URLSearchParams(form).toString();
    }
    const res = await fetch(new URL(path, BASE), { method, headers, body, redirect });
    this.#storeCookies(res);
    return res;
  }

  async login(user, pass) {
    if (!user || !pass) throw new Error('VIGOR_USUARIO e VIGOR_SENHA não configurados nos Secrets do GitHub.');
    const page = await this.#request('/Login', { accept: 'text/html' });
    const html = await page.text();
    const token = (html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/) || [])[1];
    if (!token) throw new Error('Não encontrei o formulário de login do portal (a página pode ter mudado).');
    const res = await this.#request('/Login', {
      method: 'POST', accept: 'text/html',
      form: { __RequestVerificationToken: token, Usuario: user, Senha: pass },
    });
    // Sucesso = redireciona para fora da tela de login.
    const loc = res.headers.get('location') || '';
    if (!(res.status >= 300 && res.status < 400) || /\/Login/i.test(loc)) {
      throw new Error('Login no portal da Vigor recusado. Confira usuário e senha nos Secrets do GitHub.');
    }
    // Segue o redirecionamento para receber os cookies finais da sessão.
    await this.#request(loc, { accept: 'text/html' });
  }

  async #json(path, form) {
    const res = await this.#request(path, { method: 'POST', form });
    const text = await res.text();
    let j;
    try { j = JSON.parse(text); } catch { throw new Error(`${path}: resposta inesperada (HTTP ${res.status}).`); }
    if (j.Authorized === false) throw new Error(`${path}: sessão não autorizada.`);
    if (j.Success === false) throw new Error(`${path}: ${j.Msg || 'falha'}`);
    return j;
  }

  /** Cargas com NFs emitidas no período (datas em dd/mm/aaaa). */
  async listarCargas(de, ate) {
    const cargas = [];
    for (let inicio = 0; ; inicio += 100) {
      const j = await this.#json('/ControleEntrega/ObterControleEntrega', {
        DataEmissaoNotaDe: de, DataEmissaoNotaAte: ate, inicio: String(inicio), limite: '100',
      });
      const page = j.Data || [];
      cargas.push(...page);
      if (page.length < 100 || cargas.length >= (j.QuantidadeRegistros || 0)) break;
    }
    return cargas;
  }

  async detalhesEntrega(codigo) {
    const j = await this.#json('/ControleEntregaEntrega/BuscarDetalhesEntrega', { Codigo: String(codigo), Page: 'ControleEntrega' });
    return j.Data || null;
  }

  async canhotos(codigo) {
    const j = await this.#json('/ControleEntregaEntrega/ObterMiniaturasCanhotos', { Codigo: String(codigo) });
    return (j.Data?.Imagens || []).map(i => ({ codigo: i.Codigo, nf: String(i.Numero), pdf: !!i.ArquivoPDF, esperandoVinculo: !!i.EsperandoVinculo }));
  }

  async baixarCanhoto(codigo, esperandoVinculo = false) {
    const res = await this.#request('/Canhoto/DownloadCanhoto', {
      method: 'POST', accept: '*/*', form: { Codigo: String(codigo), EsperandoVinculo: String(esperandoVinculo) },
    });
    if (!res.ok) throw new Error(`Canhoto ${codigo}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
