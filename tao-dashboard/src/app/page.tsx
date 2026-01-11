export default async function Home() {
  const res = await fetch("http://localhost:3000/api/chain/health", {
    // avoid caching while developing
    cache: "no-store",
  });

  const data = await res.json();

  return (
    <main className="p-4 max-w-xl mx-auto">
      <h1 className="text-2xl font-bold">TAO Dashboard</h1>

      <div className="mt-4 rounded-xl border p-4">
        <h2 className="font-semibold">Chain Health</h2>
        <pre className="mt-2 text-sm overflow-auto">{JSON.stringify(data, null, 2)}</pre>
      </div>
    </main>
  );
}

<a
  href="/subnets"
  className="inline-block mt-4 rounded-xl bg-white/10 hover:bg-white/15 border border-white/10 px-4 py-2 text-sm"
>
  View Subnets
</a>
