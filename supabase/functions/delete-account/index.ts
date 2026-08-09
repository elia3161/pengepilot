import { createClient } from "npm:@supabase/supabase-js@2";

const allowedOrigins = new Set([
  "https://elia3161.github.io",
  "https://localhost",
  "capacitor://localhost",
  "http://localhost"
]);

function cors(req: Request) {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": allowedOrigins.has(origin) ? origin : "https://elia3161.github.io",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin"
  };
}

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), "Content-Type": "application/json; charset=utf-8" }
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    if (String(body?.confirm || "").toUpperCase() !== "SLET") return json(req, { error: "Skriv SLET for at bekraefte permanent sletning." }, 400);

    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token || token === authHeader) return json(req, { error: "Ikke logget ind." }, 401);

    const url = Deno.env.get("SUPABASE_URL") || "";
    const anon = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!url || !anon || !service) return json(req, { error: "Serveren mangler Supabase-konfiguration." }, 500);

    const authClient = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: userData, error: userError } = await authClient.auth.getUser(token);
    if (userError || !userData.user) return json(req, { error: "Ugyldig eller udloebet session." }, 401);

    const userId = userData.user.id;
    const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
    const userOwned = ["ai_insights","savings_opportunities","bills","subscriptions","budgets","goals","category_rules","transactions","imports","categories","accounts"];
    for (const table of userOwned) {
      const { error } = await admin.from(table).delete().eq("user_id", userId);
      if (error) throw new Error(`Kunne ikke slette ${table}: ${error.message}`);
    }
    const { error: profileError } = await admin.from("profiles").delete().eq("id", userId);
    if (profileError) throw new Error(`Kunne ikke slette profil: ${profileError.message}`);
    const { error: authDeleteError } = await admin.auth.admin.deleteUser(userId);
    if (authDeleteError) throw new Error(`Kunne ikke slette login: ${authDeleteError.message}`);
    return json(req, { ok: true });
  } catch (error) {
    console.error("delete-account", error);
    return json(req, { error: error instanceof Error ? error.message : "Ukendt serverfejl" }, 500);
  }
});
