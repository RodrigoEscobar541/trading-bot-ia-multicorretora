// firebase-config.js — configuração do app web do Firebase.
//
// Preencha com os valores do SEU projeto: console do Firebase → Configurações
// do projeto → Seus apps → App da Web → "Configuração do SDK".
//
// Estes valores NÃO são segredos (identificam o projeto publicamente; a
// segurança vem do Firebase Auth + regras do Firestore — firestore.rules).
// As chaves de API do bot (Gemini/Mercado Bitcoin) NUNCA entram aqui.
//
// Os valores abaixo são PLACEHOLDERS: esta é a cópia pública do projeto, e a
// configuração do app real não vai para o repositório. Sem substituí-los, a
// dashboard carrega mas não autentica.

export const firebaseConfig = {
  apiKey: "COLE_AQUI_A_API_KEY_DO_SEU_APP_WEB",
  authDomain: "seu-projeto.firebaseapp.com",
  projectId: "seu-projeto",
  storageBucket: "seu-projeto.firebasestorage.app",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:0000000000000000000000",
  measurementId: "G-XXXXXXXXXX"
};

// ID do banco Firestore, se for diferente do canônico "(default)".
// Deixe '' para usar o banco padrão.
export const firestoreDatabaseId = '';
