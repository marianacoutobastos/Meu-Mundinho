
export async function onRequestGet(context) {
  if (!context.env.DB) {
    return Response.json(
      { ok: false, error: "Banco não conectado" },
      { status: 500 }
    );
  }

  return Response.json({
    ok: true,
    app: "Meu Mundinho",
    database: "conectado"
  });
}
