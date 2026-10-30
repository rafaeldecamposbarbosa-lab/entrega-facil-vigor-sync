# Entrega Fácil · Sincronização com a Vigor

Robô que roda sozinho no GitHub Actions e atualiza o Entrega Fácil com o resultado das
entregas informado no portal da Vigor (MultiTMS → Cargas → Controle Entrega).

- Você continua **importando as NFs** no Entrega Fácil normalmente.
- O robô procura cada NF no portal e atualiza:
  - **Entregue** → baixa a NF com data/hora e anexa a **foto do canhoto**.
  - **Devolução** → registra a ocorrência com motivo e observação.
  - **Reentrega** → marca como reentrega com o motivo.
  - Coordenadas do cliente (quando o Entrega Fácil ainda não tem).
- Roda de hora em hora, das 8h às 18h, de segunda a sábado. Cada execução fica registrada
  na tabela `integration_runs` do Supabase (o app mostra a última sincronização).
- Só **lê** o portal da Vigor; nunca altera nada lá.

## Segredos (Settings → Secrets and variables → Actions)
| Nome | O que é |
|---|---|
| `VIGOR_USUARIO` | usuário do portal da Vigor |
| `VIGOR_SENHA` | senha do portal da Vigor |
| `SUPABASE_URL` | `https://chihlpdkgqgepdijvjdy.supabase.co` |
| `SUPABASE_SECRET_KEY` | chave secreta do Supabase (Project Settings → API Keys → Secret keys) |

## Rodar na hora
Aba **Actions** → *Sincronizar Vigor -> Entrega Fácil* → **Run workflow**.
Marque "Só simular" para ver no log o que seria alterado sem gravar nada.
