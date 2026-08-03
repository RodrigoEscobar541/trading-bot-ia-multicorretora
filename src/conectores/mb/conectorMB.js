// conectorMB.js — conector do Mercado Bitcoin (API v4), implementando o
// contrato de src/conectores/conector.js. Une os submódulos:
//   - mbPublico.js → dados de mercado, sem autenticação (ticker, candles)
//   - mbPrivado.js → saldos, ordens e execução (API Token ID + Secret)
//
// Todas as ordens são A MERCADO (regras.md §9) — nunca limitadas.

import * as publico from './mbPublico.js';
import * as privado from './mbPrivado.js';

/** Cria o conector MB com as credenciais da plataforma (doc `dados/api`). */
export function criarConectorMB({ api }) {
  const credenciais = { id: api?.api_key_id, secret: api?.api_key_secret };
  return {
    id: 'mb',

    async precoAtual(par) {
      return publico.obterTicker(par);
    },

    async precos(pares) {
      return publico.obterTickers(pares);
    },

    async candles(par, resolucao, quantidade) {
      return publico.obterCandles(par, resolucao, quantidade);
    },

    async saldos() {
      return privado.obterSaldos(credenciais);
    },

    async ordensAbertas(par) {
      return privado.obterOrdensAbertas(credenciais, par);
    },

    async ordemMercado({ par, lado, valor, quantidade }) {
      return privado.criarOrdemMercado(credenciais, { simbolo: par, lado, valor, quantidade });
    },

    async aguardarFill(orderId, par) {
      return privado.aguardarFill(credenciais, orderId, { simbolo: par });
    },
  };
}
