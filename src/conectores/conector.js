// conector.js — CONTRATO dos conectores de plataforma e registro central
// (V2_Plan.MD §D). Um conector é o ÚNICO ponto de contato do sistema com a
// API de uma corretora/exchange; o restante do núcleo só conhece esta
// interface — nenhum módulo fora de src/conectores/ pode chamar a API de uma
// plataforma diretamente (CLAUDE.md §16, fronteiras de módulo).
//
// Interface que todo conector deve implementar (todas assíncronas):
//
//   precoAtual(par)            → { ultimo, maxima, minima, volume, horario, ... }
//   precos(pares)              → { 'BTC-BRL': ticker, ... } (uma chamada só,
//                                 base do patrimônio da plataforma/orçamento)
//   candles(par, res, n)       → [{ horario, abertura, maxima, minima,
//                                   fechamento, volume }] (antigo → recente)
//   saldos()                   → { moeda, saldo_moeda, saldos: { SIMBOLO: qtd } }
//   ordensAbertas(par)         → [ordens com status "working"]
//   ordemMercado({ par, lado: 'buy'|'sell', valor?, quantidade? })
//                              → { orderId }
//   aguardarFill(orderId, par) → { status, quantidade, valor, preco_medio, taxa }
//
// Método OPCIONAL (para plataformas de bolsa, com pregão/feriados):
//
//   estadoMercado()            → { aberto, estado, abre_em, fecha_em }
//     O orquestrador o usa nos ativos com `mercado24h: false`; sem ele,
//     vale a janela heurística de pregão (config da plataforma).
//
// Adicionar uma plataforma nova = criar src/conectores/<id>/ implementando a
// interface e registrá-la em CONECTORES abaixo. Nada mais muda no núcleo.

import { criarConectorMB } from './mb/conectorMB.js';
import { criarConectorTT } from './tt/conectorTT.js';
import { criarConectorBN } from './bn/conectorBN.js';
import { criarConectorTORO } from './toro/conectorTORO.js';
import { criarConectorSTEAM } from './steam/conectorSTEAM.js';

const CONECTORES = {
  mb: criarConectorMB,
  tt: criarConectorTT,
  bn: criarConectorBN,
  toro: criarConectorTORO, // modo ASSISTIDO: só leitura (brapi.dev) — nunca envia ordem
  steam: criarConectorSTEAM, // modo ASSISTIDO: a Steam não tem API de execução
};

/**
 * Cria o conector da plataforma a partir da config dela (campo `conector`)
 * e das credenciais (doc `dados/api`).
 */
export function criarConector(plataforma, api) {
  const fabrica = CONECTORES[plataforma?.conector];
  if (!fabrica) {
    throw new Error(
      `plataforma ${plataforma?.id ?? '?'} sem conector registrado (conector: ${JSON.stringify(plataforma?.conector)})`,
    );
  }
  return fabrica({ plataforma, api });
}
