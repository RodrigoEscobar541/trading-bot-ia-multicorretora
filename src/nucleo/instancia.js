// instancia.js — configuração da INSTÂNCIA do bot (arquitetura de DOIS BOTS
// por região; ver DoisBots_Plan.MD).
//
// Uma instância pode ser ESCOPADA a um subconjunto de plataformas via a env
// BOT_PLATAFORMAS (CSV). Rodando duas cópias do mesmo binário com escopos
// DISJUNTOS (ex.: MB numa região, BN/TT/TORO em outra), nenhum ativo é
// processado por duas instâncias — logo, sem risco de ordem duplicada.
//
// Uma — e SÓ uma — instância é a PRIMÁRIA (env BOT_PRIMARIO): faz o trabalho
// GLOBAL que não pode ser duplicado — migração/seed no boot (scheduler.js) e o
// recálculo do comparativo renda_real × CDI (orquestrador.js).
//
// Compatibilidade: sem NENHUMA dessas envs, o comportamento é o de bot ÚNICO —
// todas as plataformas e todas as tarefas globais ligadas. Ninguém que roda um
// bot só precisa configurar nada.

/** CSV → lista de ids em MAIÚSCULAS, sem vazios/whitespace. */
export function parsearFiltro(csv) {
  if (typeof csv !== 'string') return [];
  return csv
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

/**
 * Filtra as plataformas pelo escopo da instância (CSV de BOT_PLATAFORMAS).
 * Filtro vazio/ausente = TODAS (bot único). Comparação por id, sem diferenciar
 * maiúsculas/minúsculas. Não muta o array recebido.
 */
export function filtrarPlataformas(plataformas, csv) {
  const permitidas = parsearFiltro(csv);
  if (permitidas.length === 0) return plataformas;
  const conjunto = new Set(permitidas);
  return plataformas.filter((p) => conjunto.has(String(p?.id).toUpperCase()));
}

/** Esta instância está escopada a plataformas específicas? */
export function instanciaEscopada(env = process.env) {
  return parsearFiltro(env.BOT_PLATAFORMAS).length > 0;
}

/**
 * Esta instância faz o trabalho GLOBAL (migração/seed + renda_real × CDI)?
 *   - Bot único (sem BOT_PLATAFORMAS): SIM (implícito — comportamento atual).
 *   - Instância escopada: só quando BOT_PRIMARIO é verdadeiro (1/true/sim).
 * Exatamente UMA instância do conjunto deve ser primária.
 */
export function ehPrimario(env = process.env) {
  if (!instanciaEscopada(env)) return true;
  return /^(1|true|sim)$/i.test(String(env.BOT_PRIMARIO ?? '').trim());
}
