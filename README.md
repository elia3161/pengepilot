# PengePilot

PengePilot er en fungerende prototype til personlig økonomi med GitHub Pages som frontend-hosting og Supabase som backend.

## Arkitektur

- **Frontend:** statisk HTML/CSS/JavaScript på GitHub Pages
- **Auth:** Supabase Auth med email + password og email-bekræftelse
- **Database:** Supabase PostgreSQL
- **Sikkerhed:** Row Level Security (RLS) på alle brugerdata-tabeller
- **Bankimport:** CSV behandles lokalt i browseren; originalfilen gemmes ikke
- **Nøgler i frontend:** kun Supabase publishable key. Database-password, secret key og service-role key må aldrig ligge i repoet eller browseren.

## Funktioner

- Opret bruger, login, logout og password reset
- Brugerprofil
- Egne konti med startsaldo og beregnet aktuel saldo
- CSV-import med preview, automatisk kolonnegenkendelse, kategorisering og dubletbeskyttelse
- Transaktioner med manuel kategorirettelse
- Dashboard baseret på brugerens egne data
- Budgetlinjer
- Opsparingsmål
- Abonnementer, regninger og spareforslag fra backend-tabeller
- Prognose, sundhedsscore, rapporter og lokal dataassistent

## Datasikkerhed

Frontend bruger Supabase publishable key. Det er RLS-politikkerne i databasen, der håndhæver, at en bruger kun kan læse og ændre egne rækker. Overførsler mellem egne konti er markeret med kategoritypen `transfer` og holdes ude af indtægts-/udgiftsberegninger.

## GitHub Pages

Deployment køres automatisk fra `main` via `.github/workflows/pages.yml`.

Live prototype:

`https://elia3161.github.io/pengepilot/`

## Næste produkttrin

- stærkere bank-specifik CSV-mapping
- automatisk detektion af abonnementer og regninger
- kategori-regler der lærer af brugerens rettelser
- Supabase Edge Function til rigtig AI-assistent uden hemmelige API-nøgler i browseren
- eksport og mere avanceret prognose
