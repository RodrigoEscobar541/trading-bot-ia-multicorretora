// conectorSTEAM.js — conector do Mercado da Comunidade Steam em MODO
// ASSISTIDO, implementando o contrato de src/conectores/conector.js
// (ROADMAP prioridade 4, fase 1).
//
// Por que assistido, como a Toro — mas por outro motivo: a Toro não tem API
// nenhuma; a Steam TEM (leitura), e o que não existe é API de EXECUÇÃO.
// Comprar ou vender automaticamente exigiria dirigir o site com o cookie da
// conta do dono, arriscando a conta. Então o robô lê, analisa e RECOMENDA;
// quem executa é o dono, no site da Steam.
//
// ordemMercado/aguardarFill LANÇAM: se algum dia forem chamados, é bug de
// fluxo, nunca uma ordem real.
//
// O "par" de um item é o `market_hash_name` exato ("AK-47 | Redline
// (Field-Tested)") — é o que a API entende. O id do documento é o slug dele
// (steamPublico.slugDoItem).

import * as steam from './steamPublico.js';
import { obterEstadoPlataforma } from '../../firebase/firebaseClient.js';

// Padrões dos três intervalos que o dono edita na seção Steam da dashboard.
// Cada rotina tem custo diferente, por isso são três números e não um.
export const INTERVALOS_PADRAO = {
  analise_minutos: 60, // 1 chamada de IA por item MARCADO
  precos_minutos: 60, // 1 chamada HTTP por item do inventário (limite ~20/min)
  noticias_minutos: 30, // 1 chamada HTTP, sempre (fase 2)
};

// Piso de 15 min nos três: um zero digitado por engano na tela viraria
// chamada em loop — contra o limite da Steam e contra a quota da IA.
export const INTERVALO_MINIMO_MINUTOS = 15;

/**
 * Os três intervalos da plataforma, saneados. Função PURA: valor ausente,
 * texto, negativo ou abaixo do piso cai no padrão/piso, nunca em NaN.
 */
export function intervalosDaPlataforma(plataforma) {
  const bruto = plataforma?.intervalos ?? {};
  const saneado = {};
  for (const [chave, padrao] of Object.entries(INTERVALOS_PADRAO)) {
    const n = Number(bruto[chave]);
    saneado[chave] = !Number.isFinite(n) || n <= 0
      ? padrao
      : Math.max(INTERVALO_MINIMO_MINUTOS, Math.round(n));
  }
  return saneado;
}

/** Cria o conector STEAM a partir da config da plataforma. */
export function criarConectorSTEAM({ plataforma, api } = {}) {
  const moeda = plataforma?.moeda || 'BRLS';
  const plataformaId = plataforma?.id || 'STEAM';
  // SteamID64 do dono (17 dígitos): identifica de quem é o inventário. NÃO é
  // segredo (está na URL do perfil), então mora no doc da plataforma, que a
  // dashboard consegue ler e editar. O `dados/api` é só fallback de `.env`
  // para desenvolvimento — de lá o navegador não lê nada.
  const steamId = plataforma?.steam_id64 || api?.steam_id64 || '';
  const moedaSteam = Number(plataforma?.moeda_steam) || steam.MOEDA_BRL;
  // Jogo desta plataforma (730 = CS2). Configurável para o dia em que entrar
  // um segundo jogo — o núcleo não precisa saber de nada disso.
  const appid = Number(plataforma?.appid) || steam.APPID_CS2;

  return {
    id: 'steam',

    async precoAtual(par) {
      return steam.obterPreco(par, { moeda: moedaSteam, appid });
    },

    // Não existe consulta em lote no mercado da Steam: os itens vão em série,
    // com pausa, para não bater no limite de ~20 chamadas por minuto.
    async precos(pares) {
      return steam.obterPrecos(pares, { moeda: moedaSteam, appid });
    },

    // Não há candles neste mercado. O único histórico oficial
    // (`/market/pricehistory/`) exige cookie de sessão da conta do dono, e a
    // decisão registrada no ROADMAP é não usá-lo. A série de preço passa a ser
    // a que o próprio bot acumular (fase 5) — até lá, quem pedir candle recebe
    // um erro explícito em vez de um array vazio que viraria indicador falso.
    async candles(par) {
      throw new steam.ErroSteam(
        `mercado da Steam não fornece candles (${par}) — a série histórica é construída pelo próprio bot`,
        { endpoint: '/market/pricehistory/' },
      );
    },

    // Carteira MANUAL, como na Toro: o dono informa o saldo da carteira Steam
    // e as operações registradas por ele mantêm as quantidades.
    async saldos() {
      const estado = await obterEstadoPlataforma(plataformaId);
      const carteira = estado.carteira_manual ?? {};
      return {
        moeda,
        saldo_moeda: Number(carteira.saldo_moeda) || 0,
        saldos: { ...(carteira.saldos ?? {}) },
      };
    },

    // Não há ordens pendentes num livro manual.
    async ordensAbertas() {
      return [];
    },

    async ordemMercado() {
      throw new Error(
        'plataforma assistida: o robô não envia ordens — compre/venda na Steam e registre a operação na dashboard',
      );
    },

    async aguardarFill() {
      throw new Error('plataforma assistida: não há fill — as operações são registradas manualmente');
    },

    // ------------------------------------------------- extensões do modo Steam
    // (fora do contrato mínimo — o núcleo não as conhece)

    /** Itens do inventário público do dono, um por item distinto. */
    async inventario() {
      if (!steamId) {
        throw new steam.ErroSteam(
          'SteamID64 não configurado — informe-o na seção Steam da dashboard',
          { endpoint: '/inventory/' },
        );
      }
      return steam.obterInventario(steamId, { appid });
    },

    /**
     * Últimas notícias OFICIAIS do jogo (notas de atualização). Único ponto
     * deste conector que fala com API oficial da Valve, e o único que não
     * depende de configuração nenhuma: funciona antes mesmo de o dono informar
     * o SteamID.
     */
    async noticias({ quantidade = 10 } = {}) {
      return steam.obterNoticias({ appid, quantidade });
    },

    /** Os três intervalos configurados pelo dono (já saneados). */
    intervalos() {
      return intervalosDaPlataforma(plataforma);
    },
  };
}
