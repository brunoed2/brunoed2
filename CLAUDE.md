# Regras do projeto

## Version badge — OBRIGATÓRIO em todo commit

**Todo commit deve incrementar o badge de versão nos dois arquivos:**
- `public/app.html` → elemento `<div id="version-badge">vXXX</div>`
- `public/painel2.html` → elemento `<div id="version-badge">vXXX</div>`

**Regras:**
- Incrementar em +1 a cada commit, sem exceção
- Ambos os arquivos no mesmo commit — nunca atualizar só um
- Vale para qualquer mudança: debug, fix, endpoint, configuração, refatoração
- Nunca commitar sem atualizar o badge primeiro
- Após o commit, sempre fazer `git push`

**Formato do commit:** `v411: descrição do que foi feito`

O badge é a única forma de confirmar que o deploy no Railway subiu. Sem ele, o usuário não sabe se o deploy foi aplicado.
