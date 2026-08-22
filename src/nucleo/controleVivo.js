// controleVivo.js — `global/controle` por LISTENER, não por leitura a cada tick.
//
// POR QUE EXISTE: o doc de controle carrega a parada de emergência, o
// kill-switch da IA, o modo vendas e os pedidos manuais da dashboard. Ele
// precisa ser responsivo, então o orquestrador o lia FRESCO a cada tick de 1
// minuto — 1.440 leituras/dia que quase sempre devolvem exatamente o mesmo
// documento. Em 14/08/2026 a quota de LEITURA do plano gratuito (50 mil/dia)
// estourou às 03:15 UTC e o bot ficou cego até a virada da quota às 07:00:
// 201 rodadas seguidas falharam em `8 RESOURCE_EXHAUSTED`, sem análise, sem
// ordem e — o que mais assusta — sem conseguir ler a própria parada de
// emergência. A gravação NÃO estourou: as 201 entradas de erro foram escritas
// normalmente, o que é a prova de que o teto derrubado era o de leitura.
//
// Um listener custa 1 leitura ao anexar e 1 a cada MUDANÇA do documento. Como
// o controle muda algumas vezes por semana, 1.440 leituras/dia viram ~1.
//
// A RESPONSIVIDADE MELHORA, não piora: hoje um clique na parada de emergência
// espera até 60 s pelo próximo tick; com o listener o valor chega em segundos
// (o efeito ainda depende do tick, mas a informação não fica mais na fila).
//
// SEGURANÇA: isto é o freio de mão de um robô que opera dinheiro de verdade —
// não pode falhar em silêncio. Sempre que o listener não estiver saudável
// (nunca anexou, backend sem suporte, ou caiu), `lerControle()` VOLTA A LER
// direto do Firestore. Degradar para o comportamento antigo custa leitura;
// degradar para um valor velho custaria uma parada de emergência ignorada.

import { obterControle, observarControle } from '../firebase/firebaseClient.js';
import { log } from '../utils/logger.js';

/** Espera mínima entre tentativas de (re)anexar o listener. */
export const REANEXAR_MS = 60_000;

let cancelar = null; // função de cancelamento do listener (null = sem listener)
let valor = null; // último documento entregue
let recebido = false; // já chegou ao menos uma entrega?
let saudavel = false; // o listener está entregando?
let tentativaEm = 0; // epoch ms da última tentativa de anexar

/** Solta o listener e volta ao estado inicial (troca de backend, testes). */
export function pararControleVivo() {
  try {
    cancelar?.();
  } catch {
    // cancelar nunca pode derrubar quem está parando o bot
  }
  cancelar = null;
  valor = null;
  recebido = false;
  saudavel = false;
  tentativaEm = 0;
}

/** Estado interno, para log e teste (nunca para decisão de negócio). */
export function estadoControleVivo() {
  return { anexado: cancelar !== null, saudavel, recebido };
}

/** Anexa o listener, no máximo uma tentativa por REANEXAR_MS. */
function anexar(agoraMs) {
  if (cancelar || agoraMs - tentativaEm < REANEXAR_MS) return;
  tentativaEm = agoraMs;
  try {
    cancelar = observarControle(
      (dados) => {
        valor = dados;
        recebido = true;
        saudavel = true;
      },
      (e) => {
        // O Firestore ENCERRA a inscrição ao falhar: marca degradado e larga a
        // referência, para a próxima tentativa reanexar de verdade.
        log.aviso('listener de global/controle caiu — voltando a ler por tick até reconectar', e);
        saudavel = false;
        cancelar = null;
      },
    );
    if (!cancelar) saudavel = false; // backend sem suporte (memória antiga)
  } catch (e) {
    log.aviso('não foi possível observar global/controle — seguindo por leitura direta', e);
    cancelar = null;
    saudavel = false;
  }
}

/**
 * O documento `global/controle` de agora. Usa o listener quando ele está
 * entregando; cai para a leitura direta em qualquer outra situação.
 */
export async function lerControle({ agoraMs = Date.now() } = {}) {
  anexar(agoraMs);
  if (saudavel && recebido) return valor;
  return obterControle();
}
