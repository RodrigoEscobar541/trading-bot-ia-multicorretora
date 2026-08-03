// validadorResposta.js — validação estrutural da resposta da IA (CLAUDE.md §6.2/§9).
//
// Garante que a IA respondeu no formato exigido antes de qualquer coisa seguir
// para o Motor de Regras. Resposta malformada NUNCA vira ordem: quem chama
// (iaClient.js) converte em AGUARDAR e loga como erro.
//
// Módulo puro: sem rede, sem log — apenas valida e normaliza.

const ACOES_VALIDAS = new Set(['COMPRAR', 'VENDER', 'AGUARDAR']);

/** Remove cercas de markdown (```json ... ```) que alguns modelos insistem em usar. */
function limparCercas(texto) {
  return texto.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
}

/**
 * Valida e normaliza a resposta bruta da IA (string JSON ou objeto).
 *
 * Retorna:
 *   { valida: true,  decisao: { acao, percentual, confianca, justificativa } }
 *   { valida: false, motivo: "..." }
 *
 * Normalizações tolerantes (documentadas):
 *   - `acao` aceita variação de caixa/espaços ("comprar" → "COMPRAR").
 *   - `percentual` numérico é arredondado para inteiro; em AGUARDAR e VENDER é
 *     forçado a 0 (venda é por posições inteiras, não por percentual).
 *   - `posicoes` (obrigatória em VENDER): lista de ids; espaços são aparados e
 *     duplicatas removidas. Vazia/ausente em VENDER invalida a resposta.
 *   - `stop_loss` + `stop_loss_motivo` (OBRIGATÓRIOS em COMPRAR — V6.6): o chão
 *     da posição que está sendo aberta e o porquê daquele valor. Ausentes ou
 *     inválidos INVALIDAM a resposta: comprar sem definir o chão não acontece.
 *     Falhar aqui é seguro — vira AGUARDAR (bloqueia compra, nunca força venda).
 *   - `ajustes_stop_loss` (opcional, qualquer ação — V6.6): lista de
 *     { id, stop_loss, motivo? } para definir/subir o chão de posições que já
 *     existem. Entradas malformadas são descartadas uma a uma; a lista inteira
 *     inválida vira [] e NUNCA invalida a resposta (é curadoria, não decisão).
 *   - `confianca` inválida vira null (campo opcional na v1) — não invalida a resposta.
 */
export function validarResposta(bruto) {
  let obj = bruto;

  if (typeof bruto === 'string') {
    try {
      obj = JSON.parse(limparCercas(bruto));
    } catch {
      return { valida: false, motivo: 'resposta não é JSON válido' };
    }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { valida: false, motivo: 'resposta não é um objeto JSON' };
  }

  // --- acao -----------------------------------------------------------------
  const acao = typeof obj.acao === 'string' ? obj.acao.trim().toUpperCase() : null;
  if (!acao || !ACOES_VALIDAS.has(acao)) {
    return { valida: false, motivo: `acao inválida: ${JSON.stringify(obj.acao)}` };
  }

  // --- percentual (só COMPRAR usa) ---------------------------------------------
  let percentual = 0; // AGUARDAR e VENDER: irrelevante — forçado a 0
  // --- stop_loss (obrigatório em COMPRAR — V6.6) --------------------------------
  let stop_loss = null;
  let stop_loss_motivo = null;
  let trailing_percentual = null;
  if (acao === 'COMPRAR') {
    const n = Number(obj.percentual);
    if (!Number.isFinite(n) || n < 1 || n > 100) {
      return {
        valida: false,
        motivo: `percentual ausente ou fora de 1..100 em ${acao}: ${JSON.stringify(obj.percentual)}`,
      };
    }
    percentual = Math.round(n);

    // Toda compra nasce com um CHÃO. Sem ele a posição ficaria sem a única
    // porta de saída no prejuízo — a resposta é reprovada (vira AGUARDAR).
    const s = Number(obj.stop_loss);
    if (!Number.isFinite(s) || s <= 0) {
      return {
        valida: false,
        motivo: `stop_loss ausente ou não positivo em COMPRAR: ${JSON.stringify(obj.stop_loss)}`,
      };
    }
    stop_loss = s;

    const m = typeof obj.stop_loss_motivo === 'string' ? obj.stop_loss_motivo.trim() : '';
    if (!m) {
      return { valida: false, motivo: 'stop_loss_motivo ausente ou vazio em COMPRAR' };
    }
    stop_loss_motivo = m;

    // `trailing_percentual` (OPCIONAL): distância que o trailing automático do
    // Motor manterá abaixo do preço enquanto esta posição estiver em lucro.
    // Ausente/inválido cai na config do ativo — por isso NÃO invalida a
    // resposta: é calibragem, não decisão, e já existe padrão para ela.
    const t = Number(obj.trailing_percentual);
    if (Number.isFinite(t) && t > 0 && t <= 50) trailing_percentual = Math.round(t * 100) / 100;
  }

  // --- ajustes_stop_loss (opcional, V6.6) ---------------------------------------
  // Define/sobe o chão de posições JÁ abertas (inclusive as sem stop). Quem
  // valida a direção (só sobe) e a faixa é o Motor; aqui só se filtra o formato.
  const ajustes_stop_loss = Array.isArray(obj.ajustes_stop_loss)
    ? obj.ajustes_stop_loss
        .filter((a) => a && typeof a === 'object' && typeof a.id === 'string' && a.id.trim())
        .map((a) => ({
          id: a.id.trim(),
          stop_loss: Number(a.stop_loss),
          motivo: typeof a.motivo === 'string' ? a.motivo.trim() : null,
        }))
        .filter((a) => Number.isFinite(a.stop_loss) && a.stop_loss > 0)
    : [];

  // --- posicoes (obrigatória em VENDER — venda por lotes, CLAUDE.md §11.1) ------
  let posicoes = null;
  if (acao === 'VENDER') {
    const lista = Array.isArray(obj.posicoes)
      ? [...new Set(obj.posicoes.filter((p) => typeof p === 'string').map((p) => p.trim()).filter(Boolean))]
      : [];
    if (lista.length === 0) {
      return {
        valida: false,
        motivo: `posicoes ausente ou vazia em VENDER: ${JSON.stringify(obj.posicoes)}`,
      };
    }
    posicoes = lista;
  }

  // --- confianca (opcional na v1) ----------------------------------------------
  const c = Number(obj.confianca);
  const confianca = Number.isFinite(c) && c >= 0 && c <= 100 ? Math.round(c) : null;

  // --- validade_contexto_dias (opcional, V6.2) ---------------------------------
  // A IA só devolve quando o prompt pede (contexto ainda sem validade). Valor
  // inválido vira null — NUNCA invalida a resposta (é curadoria, não decisão).
  const vd = Number(obj.validade_contexto_dias);
  const validade_contexto_dias = Number.isFinite(vd) && vd > 0 ? Math.round(vd) : null;

  // --- justificativa ------------------------------------------------------------
  const justificativa = typeof obj.justificativa === 'string' ? obj.justificativa.trim() : '';
  if (!justificativa) {
    return { valida: false, motivo: 'justificativa ausente ou vazia' };
  }

  return {
    valida: true,
    decisao: {
      acao,
      percentual,
      posicoes,
      stop_loss,
      stop_loss_motivo,
      trailing_percentual,
      ajustes_stop_loss,
      confianca,
      justificativa,
      validade_contexto_dias,
    },
  };
}
