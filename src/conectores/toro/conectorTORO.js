// conectorTORO.js — conector da Toro em MODO ASSISTIDO, implementando o
// contrato de src/conectores/conector.js (ROADMAP V6.0).
//
// A Toro NÃO tem API pública — nem de execução, nem de leitura. Então:
//   - Dados de mercado (cotação/candles/dividendos) vêm da brapi.dev
//     (brapiClient.js — B3, plano gratuito com token).
//   - A carteira é MANUAL: o dono registra compras/vendas e o caixa pela
//     dashboard (`carteira_manual` no doc `plataformas/TORO/dados/estado`,
//     mantida pelo processador de operações manuais — src/nucleo/
//     operacoesManuais.js). `saldos()` apenas a lê.
//   - ORDEM NUNCA É ENVIADA: a plataforma tem `assistida: true` e o executor
//     transforma aprovações do Motor em RECOMENDAÇÃO (status `sugerida`).
//     ordemMercado/aguardarFill lançam erro por segurança — se algum dia
//     forem chamados, é bug de fluxo, nunca uma ordem real.
//
// Pares na grafia da B3, sem sufixo: PETR4, VALE3, BOVA11…

import * as brapi from './brapiClient.js';
import { obterEstadoPlataforma } from '../../firebase/firebaseClient.js';

/** Cria o conector TORO com as credenciais da plataforma (doc `dados/api`). */
export function criarConectorTORO({ plataforma, api }) {
  const token = api?.brapi_token || '';
  const moeda = plataforma?.moeda || 'BRL';
  const plataformaId = plataforma?.id || 'TORO';

  return {
    id: 'toro',

    async precoAtual(par) {
      return brapi.obterCotacao(par, { token });
    },

    async precos(pares) {
      return brapi.obterCotacoes(pares, { token });
    },

    async candles(par, resolucao, quantidade) {
      return brapi.obterCandles(par, resolucao, quantidade, { token });
    },

    // Carteira MANUAL (não há API da corretora): lê o livro-caixa mantido
    // pelo dono/processador de operações manuais no estado da plataforma.
    async saldos() {
      const estado = await obterEstadoPlataforma(plataformaId);
      const carteira = estado.carteira_manual ?? {};
      return {
        moeda,
        saldo_moeda: Number(carteira.saldo_moeda) || 0,
        saldos: { ...(carteira.saldos ?? {}) },
      };
    },

    // Não existem ordens pendentes num livro manual.
    async ordensAbertas() {
      return [];
    },

    async ordemMercado() {
      throw new Error(
        'plataforma assistida: o robô não envia ordens — execute na Toro e registre a operação na dashboard',
      );
    },

    async aguardarFill() {
      throw new Error('plataforma assistida: não há fill — as operações são registradas manualmente');
    },

    // Extensão do modo assistido (fora do contrato mínimo): proventos em
    // dinheiro do ticker. NÃO é mais consumido automaticamente (V6.3 — o plano
    // gratuito da brapi retorna HTTP 403 em dividendos; o dono informa o valor
    // por ação pela dashboard). Mantido para um eventual plano pago.
    async dividendos(par) {
      return brapi.obterDividendos(par, { token });
    },
  };
}
