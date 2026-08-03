// conectorBN.js — conector da Binance (API Spot), implementando o contrato
// de src/conectores/conector.js. Une os submódulos:
//   - bnPublico.js → dados de mercado, sem autenticação (ticker, candles)
//   - bnPrivado.js → saldos, ordens e execução (API Key + Secret, HMAC SHA256)
//
// Todas as ordens são A MERCADO (regras.md §9) — nunca limitadas.
// Cripto negocia 24/7 (`mercado24h: true` nos ativos) — sem estadoMercado().
// Pares SEM hífen, na grafia da Binance: BTCBRL, ETHBRL, SOLBRL…

import * as publico from './bnPublico.js';
import * as privado from './bnPrivado.js';

/** Cria o conector BN com as credenciais da plataforma (doc `dados/api`). */
export function criarConectorBN({ plataforma, api }) {
  const credenciais = {
    apiKey: api?.bn_api_key,
    apiSecret: api?.bn_api_secret,
    moeda: plataforma?.moeda || 'BRL', // moeda de cotação dos pares (quote)
  };
  return {
    id: 'bn',

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
