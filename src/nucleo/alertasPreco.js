// alertasPreco.js — alerta de preço-alvo por item (ROADMAP prioridade 4,
// fase 5). "Me avise se essa faca cair abaixo de R$ 300."
//
// Por que existe separado da análise da IA: o alerta é a forma BARATA de
// acompanhar um item. Ele não gasta chamada de IA, não abre posição e não
// depende de o item estar marcado para análise — o dono pode vigiar cinquenta
// itens e mandar a IA analisar três.
//
// Quem escreve os alvos é a DASHBOARD; quem os confere é o bot, na mesma
// rodada em que já atualizou os preços do inventário (nenhuma consulta nova à
// Steam). O estado "já avisei" vive no MESMO documento, num campo separado, e
// não em memória: o bot reinicia a cada deploy, e o dono receberia o mesmo
// alerta de novo toda vez.

import { notificarAlertaPreco } from '../notificacoes/telegram.js';
import { log } from '../utils/logger.js';

/**
 * Compara os preços de agora com os alvos configurados. Função PURA.
 *
 * A regra é DISPARA UMA VEZ POR TRAVESSIA, com rearme automático:
 *  - "abaixo de X" dispara quando o preço toca ou fura X, e só volta a valer
 *    depois que o preço subir acima de X de novo.
 *  - "acima de Y", o espelho disso.
 *
 * Sem o rearme, um item parado abaixo do alvo geraria um aviso por hora, para
 * sempre — e o dono desligaria os avisos, que é o pior desfecho possível. Sem
 * o disparo na travessia, ele descobriria a queda tarde.
 *
 * @returns {{ disparos: Array, estado: object }} `estado` já é o novo, para
 *   persistir; `disparos` é o que precisa ser avisado agora.
 */
export function avaliarAlertas(itens, alvosPorItem = {}, estadoAnterior = {}) {
  const disparos = [];
  const estado = { ...estadoAnterior };

  for (const item of Array.isArray(itens) ? itens : []) {
    const alvo = alvosPorItem?.[item?.id];
    const preco = item?.preco;
    // Item sem alvo configurado ou sem preço legível fica de fora. Preço null
    // não é "preço zero": não dá para dizer se cruzou coisa nenhuma.
    if (!alvo || !Number.isFinite(preco)) continue;

    const anterior = estado[item.id] ?? {};
    const novo = { ...anterior };

    const abaixo = Number(alvo.abaixo);
    if (Number.isFinite(abaixo) && abaixo > 0) {
      if (preco <= abaixo && !anterior.disparado_abaixo) {
        disparos.push({ id: item.id, nome: item.market_hash_name, tipo: 'abaixo', alvo: abaixo, preco });
        novo.disparado_abaixo = true;
      } else if (preco > abaixo) {
        novo.disparado_abaixo = false; // rearma
      }
    } else {
      delete novo.disparado_abaixo;
    }

    const acima = Number(alvo.acima);
    if (Number.isFinite(acima) && acima > 0) {
      if (preco >= acima && !anterior.disparado_acima) {
        disparos.push({ id: item.id, nome: item.market_hash_name, tipo: 'acima', alvo: acima, preco });
        novo.disparado_acima = true;
      } else if (preco < acima) {
        novo.disparado_acima = false; // rearma
      }
    } else {
      delete novo.disparado_acima;
    }

    estado[item.id] = novo;
  }

  return { disparos, estado };
}

/**
 * Confere os alvos e avisa no Telegram. NUNCA lança: alerta é acessório e não
 * pode derrubar a rodada nem impedir a atualização do inventário.
 *
 * Devolve o estado novo para quem chamou persistir — este módulo não escreve
 * no banco, para continuar puro o suficiente para ser testado sem Firestore.
 */
export async function dispararAlertas({ itens, alvos = {}, estado = {}, configTelegram = null, moeda = 'BRLS' } = {}) {
  try {
    const resultado = avaliarAlertas(itens, alvos, estado);
    for (const d of resultado.disparos) {
      await notificarAlertaPreco({ alerta: { ...d, moeda }, config: configTelegram });
    }
    if (resultado.disparos.length > 0) {
      log.info(`alertas de preço: ${resultado.disparos.length} disparo(s)`);
    }
    return resultado;
  } catch (e) {
    log.aviso('falha ao conferir os alertas de preço', e);
    return { disparos: [], estado };
  }
}
