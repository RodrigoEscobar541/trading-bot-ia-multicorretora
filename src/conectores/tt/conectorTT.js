// conectorTT.js — conector da Tastytrade (Open API), implementando o
// contrato de src/conectores/conector.js. Une os submódulos:
//   - ttAuth.js       → OAuth2 (refresh token permanente → access token ~15 min)
//   - ttMarketData.js → cotações REST + candles via streamer DXLink
//   - ttRest.js       → conta, saldos, ordens, execução e sessões de mercado
//
// Todas as ordens são A MERCADO (regras.md §9): compra por VALOR usa
// 'Notional Market' (fração de ação); venda usa 'Market' por quantidade.
// Além do contrato básico, implementa o método OPCIONAL `estadoMercado()`
// (pregão/feriados direto da corretora), usado pelo orquestrador para os
// ativos com `mercado24h: false`.

import * as marketData from './ttMarketData.js';
import * as rest from './ttRest.js';

const CACHE_MERCADO_MS = 5 * 60_000; // estado do pregão muda devagar

/** Cria o conector TT com as credenciais da plataforma (doc `dados/api`). */
export function criarConectorTT({ api }) {
  const credenciais = {
    clientSecret: api?.tt_client_secret,
    refreshToken: api?.tt_refresh_token,
    contaId: api?.tt_account_id || null,
    ambiente: api?.tt_ambiente || 'producao', // 'cert' aponta para o sandbox
  };
  let cacheMercado = null; // { valor, expiraEmMs }

  return {
    id: 'tt',

    async precoAtual(par) {
      return marketData.obterCotacao(credenciais, par);
    },

    async precos(pares) {
      return marketData.obterCotacoes(credenciais, pares);
    },

    async candles(par, resolucao, quantidade) {
      return marketData.obterCandles(credenciais, par, resolucao, quantidade);
    },

    async saldos() {
      return rest.obterSaldos(credenciais);
    },

    async ordensAbertas(par) {
      return rest.obterOrdensAbertas(credenciais, par);
    },

    async ordemMercado({ par, lado, valor, quantidade }) {
      return rest.criarOrdemMercado(credenciais, { simbolo: par, lado, valor, quantidade });
    },

    async aguardarFill(orderId, par) {
      return rest.aguardarFill(credenciais, orderId, { simbolo: par });
    },

    // Método OPCIONAL do contrato (§10.11): prova que a credencial OPERA, não
    // só lê. Usa o mesmo dry-run das taxas — nada é enviado ao livro.
    async podeExecutar({ par } = {}) {
      return rest.testarOrdem(credenciais, { simbolo: par });
    },

    /**
     * Estado do pregão de ações dos EUA (aberto/fechado/próxima abertura),
     * com cache curto — cobre feriados e meio-pregão pela própria corretora.
     */
    async estadoMercado() {
      if (cacheMercado && Date.now() < cacheMercado.expiraEmMs) return cacheMercado.valor;
      const valor = await rest.estadoMercado(credenciais);
      cacheMercado = { valor, expiraEmMs: Date.now() + CACHE_MERCADO_MS };
      return valor;
    },
  };
}
