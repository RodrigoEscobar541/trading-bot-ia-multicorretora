// patrimonio.js — o total consolidado da Visão geral (V8.17).
//
// Módulo PURO, sem DOM e sem Firebase, pelo mesmo motivo do `orcamentos.js`: é
// a conta que aparece no MAIOR número da tela, e ela viveu meses errada dentro
// do `app.js` sem ninguém conseguir testá-la.
//
// AS DUAS REGRAS QUE ELA EXISTE PARA GUARDAR:
//
// 1. **Só dinheiro REAL.** O doc `dados/dashboard` de cada ativo guarda a
//    carteira do modo em que ELE roda, e a da simulação é virtual. Somar as
//    duas mostrava dinheiro que não existe — e de forma NÃO DETERMINÍSTICA,
//    porque o caixa de cada moeda era o do snapshot mais recente: ora o real,
//    ora o virtual da mesma plataforma.
// 2. **O caixa é por PLATAFORMA, não por moeda.** Três plataformas em BRL têm
//    três caixas diferentes, e os três entram no total. O código antigo
//    guardava um caixa por MOEDA — com BN, MB e TORO todas em BRL, dois dos
//    três desapareciam da conta.
//
// A conversão para BRL acontece só no fim, pelo câmbio do BCB. Moeda sem
// cotação fica FORA do total e é reportada, nunca convertida por um palpite.

/** Só a carteira do modo real entra no patrimônio. */
const carteiraRealDe = (leve) => {
  const c = leve?.dashboard?.carteira_atual;
  return c?.modo === 'real' ? c : null;
};

/**
 * Consolida caixa, posições e lucro não realizado de todas as plataformas.
 *
 * @param {object} p
 *   plataformas — Map(pid → { dados: { moeda }, ativos: Map, porAtivo: Map })
 *   cambio — doc `global/cambio` ({ USD: { para_brl } }) ou null
 *   excluir — ids de plataforma que ficam fora (a STEAM: carteira de jogo, que
 *     não dá para sacar — misturá-la sugeriria capital aplicável)
 * @returns {{ patrimonioBRL, caixaBRL, naoRealizadoBRL, temDados, semCambio, porPlataforma }}
 */
export function consolidarPatrimonio({ plataformas, cambio = null, excluir = [] }) {
  const fora = new Set(excluir);
  const porPlataforma = new Map();

  for (const [pid, p] of plataformas) {
    if (fora.has(pid)) continue;
    const moeda = p.dados?.moeda ?? 'BRL';
    const acumulado = { moeda, caixa: null, caixaEm: '', posicoes: 0, naoRealizado: 0 };

    for (const aid of p.ativos.keys()) {
      const carteira = carteiraRealDe(p.porAtivo?.get(aid));
      if (!carteira) continue;

      // O caixa é o MESMO em todos os ativos reais da plataforma: vale o
      // snapshot mais recente, nunca a soma (somar contaria N vezes).
      if (carteira.saldo_moeda != null && String(carteira.atualizada_em ?? '') >= acumulado.caixaEm) {
        acumulado.caixa = carteira.saldo_moeda;
        acumulado.caixaEm = String(carteira.atualizada_em ?? '');
      }
      if (carteira.saldo_ativo != null && carteira.preco_atual != null) {
        acumulado.posicoes += carteira.saldo_ativo * carteira.preco_atual;
      }
      if (carteira.lucro_nao_realizado != null) acumulado.naoRealizado += carteira.lucro_nao_realizado;
    }

    if (acumulado.caixa !== null || acumulado.posicoes !== 0) porPlataforma.set(pid, acumulado);
  }

  const fatorBRL = (moeda) => (moeda === 'BRL' ? 1 : cambio?.[moeda]?.para_brl ?? null);
  let patrimonioBRL = 0;
  let caixaBRL = 0;
  let naoRealizadoBRL = 0;
  let temDados = false;
  const semCambio = new Set();

  for (const { moeda, caixa, posicoes, naoRealizado } of porPlataforma.values()) {
    const fator = fatorBRL(moeda);
    if (fator === null) {
      semCambio.add(moeda);
      continue;
    }
    temDados = true;
    patrimonioBRL += ((caixa ?? 0) + posicoes) * fator;
    if (caixa !== null) caixaBRL += caixa * fator;
    naoRealizadoBRL += naoRealizado * fator;
  }

  return { patrimonioBRL, caixaBRL, naoRealizadoBRL, temDados, semCambio: [...semCambio], porPlataforma };
}
