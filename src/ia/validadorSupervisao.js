// validadorSupervisao.js — validação estrutural da resposta do SUPERVISOR
// semanal (V7.2), o agente que audita o analista e reescreve uma camada do
// prompt dele.
//
// Por que este módulo é mais rígido que o `validadorResposta`: ali uma resposta
// ruim vira AGUARDAR e o ciclo segue; aqui uma resposta ruim entraria no prompt
// de TODAS as análises da semana seguinte. O princípio é o oposto do tolerante:
// na dúvida, RECUSA a versão nova e o sistema mantém a camada anterior (que já
// estava em uso e não quebrou nada).
//
// Módulo puro: sem rede, sem persistência, sem log.

/** Teto do texto que vai para o prompt do analista (caracteres). */
export const MAX_SUPERVISAO = 6000;
/** Teto do texto que vai para o dono no Telegram. */
export const MAX_DIAGNOSTICO = 1200;
const MAX_MUDANCAS = 8;
const MAX_PALPITES = 10;
const MAX_ITEM = 400;

/** Remove cercas de markdown (```json … ```) que alguns modelos insistem em usar. */
function limparCercas(texto) {
  return texto.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
}

const texto = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/**
 * Padrões que a camada NÃO pode conter. Não é sandbox — é rede de segurança
 * contra a falha mais provável do supervisor: tentar mandar no FORMATO da
 * resposta do analista (que é fixado por contrato blindado no montadorPrompt) ou
 * revogar as regras gerais. Qualquer um deles quebraria 100% das análises, como
 * já aconteceu em 2026-07-19 por edição manual de template.
 */
const PROIBIDOS = [
  { re: /"?\bacao\b"?\s*[:=]/i, motivo: 'tenta redefinir o campo `acao` da resposta do analista' },
  { re: /\bformato de sa[ií]da\b/i, motivo: 'tenta instruir sobre o formato de saída' },
  { re: /```/, motivo: 'contém bloco de código' },
  { re: /\bignore\b[^.\n]{0,40}\bregras gerais\b/i, motivo: 'manda ignorar as regras gerais' },
  { checar: autorizaVendaNoPrejuizo, motivo: 'autoriza venda no prejuízo (só o Motor faz isso, pelo stop-loss)' },
];

const NEGACOES = /\b(nunca|n[ãa]o|jamais|evit\w*|proib\w*|sem|contra|impede|impedir)\b/i;
const VERBO_VENDA = /\bvend\w*|\brealiz\w*|\bsa[ií]da\b|\bsair\b/i;

/**
 * A camada AUTORIZA venda no prejuízo?
 *
 * Regex simples aqui dá falso positivo caro: "evite venda no prejuízo" e
 * "3 lotes fecharam com venda no prejuízo" (evidência legítima) derrubariam a
 * versão INTEIRA, e o dono veria a camada parar de atualizar sem entender por
 * quê. Então a checagem é por ORAÇÃO: só reprova quando a frase fala em vender
 * no prejuízo E não carrega nenhuma negação — que é a forma que uma
 * autorização de fato teria.
 */
function autorizaVendaNoPrejuizo(conteudo) {
  for (const oracao of conteudo.split(/[.\n;]/)) {
    if (!/\bno preju[ií]zo\b/i.test(oracao)) continue;
    if (!VERBO_VENDA.test(oracao)) continue;
    if (NEGACOES.test(oracao)) continue; // "nunca venda no prejuízo" é reforço, não autorização
    return true;
  }
  return false;
}

/**
 * Valida e normaliza a resposta bruta do supervisor (string JSON ou objeto).
 *
 * Retorna:
 *   { valida: true,  supervisao: { diagnostico, conteudo, mudancas, palpites, confianca } }
 *   { valida: false, motivo: '...' }
 *
 * Regras:
 *   - `diagnostico` e `supervisao_md` são obrigatórios; sem eles não há entrega.
 *   - `supervisao_md` acima de MAX_SUPERVISAO é RECUSADO (nunca truncado): o
 *     corte cairia no meio de uma frase e viraria instrução pela metade.
 *   - conteúdo que fira um dos PROIBIDOS é recusado inteiro.
 *   - `mudancas` e `palpites` são curadoria: entradas malformadas são
 *     descartadas uma a uma e nunca invalidam a resposta.
 *   - `confianca` inválida vira null sem invalidar.
 */
export function validarSupervisao(bruto) {
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

  const diagnostico = texto(obj.diagnostico, MAX_DIAGNOSTICO);
  if (!diagnostico) return { valida: false, motivo: 'diagnostico ausente ou vazio' };

  if (typeof obj.supervisao_md !== 'string') {
    return { valida: false, motivo: 'supervisao_md ausente ou não é texto' };
  }
  const conteudo = obj.supervisao_md.trim();
  if (conteudo.length > MAX_SUPERVISAO) {
    return { valida: false, motivo: `supervisao_md com ${conteudo.length} caracteres (máximo ${MAX_SUPERVISAO})` };
  }
  for (const { re, checar, motivo } of PROIBIDOS) {
    const bateu = checar ? checar(conteudo) : re.test(conteudo);
    if (bateu) return { valida: false, motivo: `supervisao_md ${motivo}` };
  }

  const mudancas = (Array.isArray(obj.mudancas) ? obj.mudancas : [])
    .map((m) => texto(m, MAX_ITEM))
    .filter(Boolean)
    .slice(0, MAX_MUDANCAS);

  const palpites = (Array.isArray(obj.palpites) ? obj.palpites : [])
    .map((p) => {
      if (typeof p !== 'object' || p === null) return null;
      const observacao = texto(p.observacao, MAX_ITEM);
      if (!observacao) return null;
      return {
        plataforma: texto(p.plataforma, 20),
        ativo: texto(p.ativo, 20),
        posicao_id: texto(p.posicao_id, 60),
        observacao,
      };
    })
    .filter(Boolean)
    .slice(0, MAX_PALPITES);

  const c = Number(obj.confianca);
  const confianca = Number.isFinite(c) && c >= 0 && c <= 100 ? Math.round(c) : null;

  return { valida: true, supervisao: { diagnostico, conteudo, mudancas, palpites, confianca } };
}

/**
 * Recorta a camada para UM ativo: o preâmbulo (antes do primeiro `##`), as
 * seções gerais e a seção `## PLATAFORMA/ATIVO` daquele ativo — nunca as dos
 * outros. Função pura.
 *
 * Existe porque a camada é um documento GLOBAL (uma chamada de IA por semana,
 * visão cruzada entre ativos), mas mandar a nota da PBR para o analista do BTC
 * seria ruído puro no prompt — e ruído em prompt custa qualidade de decisão.
 *
 * Convenção: um título `## X/Y` é entendido como seção DE ATIVO; qualquer outro
 * título (`## Geral`, `## Custos`, …) é geral e entra sempre.
 */
export function recortarSupervisao(conteudo, plataformaId, ativoId) {
  if (typeof conteudo !== 'string' || !conteudo.trim()) return '';
  const alvo = `${plataformaId}/${ativoId}`.toUpperCase();
  const linhas = conteudo.split('\n');

  const saida = [];
  let incluindo = true; // preâmbulo entra sempre
  for (const linha of linhas) {
    const titulo = /^##\s+(.+?)\s*$/.exec(linha);
    if (titulo) {
      const nome = titulo[1].trim();
      const deAtivo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(nome);
      incluindo = !deAtivo || nome.toUpperCase() === alvo;
    }
    if (incluindo) saida.push(linha);
  }
  return saida.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
