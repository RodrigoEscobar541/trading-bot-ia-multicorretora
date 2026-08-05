// formatador.js — utilitários de formatação e geração de identificadores.
// Apenas apresentação/formato: nenhuma regra de negócio vive aqui.

// Formatadores de moeda, criados sob demanda e reaproveitados (montar um
// Intl.NumberFormat não é barato, e o log é caminho quente).
const formatadores = new Map(); // código da moeda → Intl.NumberFormat

/**
 * Formata um valor na MOEDA DA PLATAFORMA (`moeda` do doc `plataformas/{P}`):
 * BRL no MB/BN/Toro, USD na Tastytrade. Existia antes um `formatarBRL` fixo,
 * herdado da V1 (um só ativo, uma só moeda) — ele fazia o log de uma ação
 * americana sair como "R$ 331,92", e quem abre o log de madrugada para
 * entender uma ordem lê o número errado sem desconfiar.
 *
 * Nunca lança: moeda ausente ou inválida cai no número puro + o código. Isto é
 * log e mensagem de operação — formatar não pode derrubar um ciclo.
 */
export function formatarDinheiro(valor, moeda = 'BRL') {
  if (valor === null || valor === undefined || !Number.isFinite(Number(valor))) return '—';
  const codigo = typeof moeda === 'string' && moeda.trim() ? moeda.trim().toUpperCase() : 'BRL';
  if (!formatadores.has(codigo)) {
    try {
      formatadores.set(codigo, new Intl.NumberFormat('pt-BR', { style: 'currency', currency: codigo }));
    } catch {
      formatadores.set(codigo, null); // código não reconhecido pelo Intl
    }
  }
  const fmt = formatadores.get(codigo);
  return fmt ? fmt.format(Number(valor)) : `${Number(valor).toFixed(2)} ${codigo}`;
}

/**
 * Gera o ID de operação no padrão da seção 6.3 do CLAUDE.md,
 * ex.: op_20260710_143000 (UTC).
 */
export function gerarIdOperacao(data = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const ymd = `${data.getUTCFullYear()}${p(data.getUTCMonth() + 1)}${p(data.getUTCDate())}`;
  const hms = `${p(data.getUTCHours())}${p(data.getUTCMinutes())}${p(data.getUTCSeconds())}`;
  return `op_${ymd}_${hms}`;
}

/** Timestamp ISO-8601 UTC sem milissegundos, como nos exemplos da especificação. */
export function timestampISO(data = new Date()) {
  return data.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
