<!--
  The anchor lines of multivac's public documentation (DESIGN.md of github.com/ulm0/multivac, MIT, (c) 2026 Pierre Ugaz), with the repo key rewritten to `brain`
  (gonogo's store has one repo), and the lines multivac accepts that gonogo's grammar does not support. test/anchorgrammar.test.ts reads the sections below:
  "ACCEPT" lines must parse, "REFUSE" lines must be a diagnostic and never a crash. A line is one anchor.
-->

## ACCEPT: the four legs of the INV-01 example
<!-- @anchor INV-01 brain:db/migrations/*.sql /revoke[[:space:]]+update[[:space:]]+on[[:space:]]+[^[:space:]]*balances/i -->
<!-- @anchor INV-01 brain:db/migrations/*.sql /grant[[:space:]]+update[[:space:]]+on[[:space:]]+[^[:space:]]*balances/i absent -->
<!-- @anchor INV-01 brain:db/migrations/*.sql /update[[:space:]]+balances/i count=1 -->
<!-- @anchor INV-01 brain:db/migrations/*.sql /on[[:space:]]+conflict[^;]*balance/i absent -->

## ACCEPT: the dead-term tombstone, an exclusion, every mode
<!-- @anchor INV-83 brain:AGENTS.md /(^|[^[:alnum:]_])VOUCHER([^[:alnum:]_]|$)/ absent -->
<!-- @anchor INV-77 brain:**.md !07-rules.md /PIN/ absent -->
<!-- @anchor INV-78 brain:**.md !brain:07-rules.md /PIN/ absent -->
<!-- @anchor INV-79 brain:src/**/*.ts !**/*.test.ts /export const VERSION/ unique -->
<!-- @anchor INV-80 brain:src/**/*.ts /^import / each -->
<!-- @anchor INV-81 brain:src/**/*.ts /console\.log/ each! -->
<!-- @anchor INV-82 brain:{src,lib}/*.ts /TODO/i present -->
<!-- @anchor INV-84 brain:.github/**/*.yml /uses: / count=3 -->

## ACCEPT: gonogo's literal in place of a regex
<!-- @anchor K-1 brain:docs/*.md "a fixed string" absent -->
<!-- @anchor K-2 brain:src/server/hub.ts "say \"hello\" and \\ more" -->

## REFUSE: what multivac supports and a store of one repo does not
<!-- @anchor INV-90 backend:db/migrations/*.sql /grant/ absent -->
<!-- @anchor INV-91 *:**.md /VOUCHER/ absent -->
<!-- @anchor INV-92 brain:**.md !backend:x.md /PIN/ absent -->

## REFUSE: the dialect gate
<!-- @anchor INV-93 brain:*.ts /\bword\b/ -->
<!-- @anchor INV-94 brain:*.ts /foo\d/ -->
<!-- @anchor INV-95 brain:*.ts /PIN[:digit:]/ absent -->
<!-- @anchor INV-96 brain:*.ts /(a)\1/ -->
<!-- @anchor INV-97 brain:*.ts /a*?b/ -->
<!-- @anchor INV-98 brain:*.ts /a(?=b)/ -->
<!-- @anchor INV-99 brain:*.ts /x/g -->
<!-- @anchor INV-100 brain:*.ts /[unclosed/ -->

## REFUSE: what gonogo adds
<!-- @anchor G-1 brain:*.ts /(a+)+$/ -->
<!-- @anchor G-2 brain:../x/*.ts /a/ -->
<!-- @anchor G-3 brain:/etc/*.conf /a/ -->
<!-- @anchor G-4 brain:~/x /a/ -->
<!-- @anchor G-5 brain:a\b /a/ -->
<!-- @anchor G-6 brain:a//b /a/ -->
<!-- @anchor G-7 brain:C:x /a/ -->
<!-- @anchor G-8 brain:*.ts "" -->
<!-- @anchor G-9 brain:*.ts "unterminated -->

## IGNORED: documentation, not law
```markdown
<!-- @anchor DOC-1 brain:**.md /not a live anchor/ absent -->
```

    <!-- @anchor DOC-2 brain:**.md /indented four spaces: code/ absent -->
