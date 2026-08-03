#!/usr/bin/env node
// publicar-regras.mjs — sobe as SEMENTES de prompt do repositório para os docs
// que a IA realmente lê (`global/regras_gerais` e `global/regras_gerais_venda`).
//
// POR QUE PRECISA EXISTIR: os arquivos `.md/` são só semente — depois da
// primeira inicialização a fonte de verdade é o Firestore, e editar o .md não
// muda nada no que a IA recebe. Sem isto, a V8.8 mexeria no Motor e deixaria o
// prompt ensinando a regra antiga.
//
// USO:
//   node publicar-regras.mjs              # mostra o que faria (diff resumido)
//   node publicar-regras.mjs --executar   # grava, incrementando a versão

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync, writeFileSync } from 'node:fs';

const EXECUTAR = process.argv.includes('--executar');
// JSON da service account do Firebase Admin, baixado do console e mantido FORA
// do repositório (o .gitignore cobre `*adminsdk*.json`). Ajuste o nome do
// arquivo para o seu, ou aponte para o caminho que preferir.
const CHAVE = './service-account-adminsdk.json';

initializeApp({ credential: cert(JSON.parse(readFileSync(CHAVE, 'utf8'))) });
const db = getFirestore();

const DOCS = [
  { doc: 'regras_gerais', semente: '.md/regras_gerais.md' },
  { doc: 'regras_gerais_venda', semente: '.md/regras_gerais_venda.md' },
];

for (const { doc, semente } of DOCS) {
  const conteudo = readFileSync(semente, 'utf8');
  const ref = db.doc(`global/${doc}`);
  const atual = (await ref.get()).data() || {};

  if ((atual.conteudo ?? '') === conteudo) {
    console.log(`= ${doc}: já idêntico ao ${semente} (versão ${atual.versao ?? '?'}) — nada a fazer`);
    continue;
  }

  console.log(`~ ${doc}: versão ${atual.versao ?? 0} → ${(atual.versao ?? 0) + 1}`);
  console.log(`  banco: ${(atual.conteudo ?? '').length} caracteres | ${semente}: ${conteudo.length}`);

  if (!EXECUTAR) {
    console.log('  (simulação — use --executar para gravar)');
    continue;
  }

  // Backup do texto que está no ar, para poder voltar sem depender do git.
  const backup = `backup_${doc}_${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
  writeFileSync(backup, atual.conteudo ?? '');
  console.log(`  backup do texto atual em ${backup}`);

  await ref.set(
    { conteudo, versao: (atual.versao ?? 0) + 1, atualizado_em: new Date().toISOString() },
    { merge: true },
  );
  console.log('  GRAVADO');
}

console.log(
  EXECUTAR
    ? '\nPronto. O bot lê o prompt pelo catálogo cacheado: a mudança vale em até 5 minutos.'
    : '\nNada foi gravado.',
);
process.exit(0);
