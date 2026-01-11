import { notFound } from "next/navigation";

type Subnet = {
  netuid: number;
  emission: string; // TAO
  subnetTAO: string; // TAO
  subnetTaoFlow: string; // TAO
  subnetTaoFlowDir: "up" | "down" | "flat";
  subnetEmaTaoFlow: string; // TAO
  subnetEmaTaoFlowDir: "up" | "down" | "flat";
  subnetMovingPrice: string; // decoded
};

type SubnetsResponse = {
  ok: boolean;
  updatedAt: string;
  totalNetworks: number;
  blockEmission: string; // TAO/block
  subnets: Subnet[];
};

type IdentityResponse = {
  ok: boolean;
  netuid: number;
  identity: {
    name: string | null;
    description: string | null;
    url: string | null;
    discord: string | null;
    github: string | null;
  };
  rawHuman?: any;
};

function Arrow({ dir }: { dir: "up" | "down" | "flat" }) {
  if (dir === "up") return <span className="text-green-400">↑</span>;
  if (dir === "down") return <span className="text-red-400">↓</span>;
  return <span className="text-gray-400">→</span>;
}

function Row({
  label,
  value,
  right,
}: {
  label: string;
  value: string;
  right?: React.ReactNode;
}) {
  const display =
    value === "null" || value === "undefined" || value.trim() === ""
      ? "—"
      : value;

  return (
    <div className="flex items-center justify-between gap-4 py-2 border-b border-white/10">
      <div className="text-sm text-gray-400">{label}</div>
      <div className="text-sm font-medium text-gray-100 tabular-nums text-right">
        {display} {right}
      </div>
    </div>
  );
}

function ExternalLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-sm text-gray-300 hover:text-white underline underline-offset-4"
    >
      {label}
    </a>
  );
}

export default async function SubnetDetailPage({
  params,
}: {
  params: Promise<{ netuid: string }>;
}) {
  const { netuid } = await params;
  const id = Number(netuid);
  if (!Number.isFinite(id)) notFound();

  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

  const [subnetsRes, identRes] = await Promise.all([
    fetch(`${baseUrl}/api/subnets`, { cache: "no-store" }),
    fetch(`${baseUrl}/api/subnets/${id}/identity`, { cache: "no-store" }),
  ]);

  const data: SubnetsResponse = await subnetsRes.json();
  const ident: IdentityResponse = await identRes.json();

  const subnet = data.subnets.find((s) => s.netuid === id);
  if (!subnet) notFound();

  // Prefer parsed fields, but fall back to rawHuman keys we saw in your output
  const name =
    ident?.identity?.name ??
    ident?.rawHuman?.subnetName ??
    `Subnet ${subnet.netuid}`;

  const description =
    ident?.identity?.description ?? ident?.rawHuman?.description ?? null;

  const website = ident?.rawHuman?.subnetUrl ?? ident?.identity?.url ?? null;
  const github = ident?.rawHuman?.githubRepo ?? ident?.identity?.github ?? null;
  const logoUrl = ident?.rawHuman?.logoUrl ?? null;

  return (
    <main className="min-h-screen p-4 sm:p-6">
      <div className="mx-auto max-w-2xl">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoUrl}
                alt={`${name} logo`}
                className="h-12 w-12 rounded-xl border border-white/10 bg-white/5 object-cover"
              />
            ) : null}

            <div>
              <h1 className="text-2xl sm:text-3xl font-bold">
                {name}{" "}
                <span className="text-gray-400 font-normal">
                  (Subnet <span className="tabular-nums">{subnet.netuid}</span>)
                </span>
              </h1>

              {description ? (
                <p className="mt-1 text-sm text-gray-300 max-w-prose">
                  {description}
                </p>
              ) : (
                <p className="mt-1 text-sm text-gray-500">
                  No description set on-chain.
                </p>
              )}

              <p className="text-sm text-gray-400 mt-2">
                Updated: <span className="tabular-nums">{data.updatedAt}</span>
              </p>

              <div className="mt-2 flex flex-wrap gap-4">
                {website ? <ExternalLink href={website} label="Website" /> : null}
                {github ? <ExternalLink href={github} label="GitHub" /> : null}
              </div>
            </div>
          </div>

          <div className="flex gap-3">
            <a
              href="/subnets"
              className="text-sm text-gray-300 hover:text-white underline underline-offset-4"
            >
              Back
            </a>
            <a
              href="/"
              className="text-sm text-gray-300 hover:text-white underline underline-offset-4"
            >
              Home
            </a>
          </div>
        </div>

        <div className="mt-5 rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="text-sm text-gray-400">At a glance</div>
          <div className="mt-1 text-lg font-semibold tabular-nums">
            Emission: {subnet.emission} TAO
          </div>
          <div className="mt-1 text-sm text-gray-300 tabular-nums">
            Block emission: {data.blockEmission} TAO/block
          </div>
        </div>

        <div className="mt-5 rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="text-sm font-semibold mb-2">Stats</div>

          <Row label="Subnet emission" value={`${subnet.emission} TAO`} />
          <Row label="Subnet TAO" value={`${subnet.subnetTAO} TAO`} />

          <Row
            label="TAO flow"
            value={`${subnet.subnetTaoFlow} TAO`}
            right={<Arrow dir={subnet.subnetTaoFlowDir} />}
          />

          <Row
            label="EMA TAO flow"
            value={`${subnet.subnetEmaTaoFlow} TAO`}
            right={<Arrow dir={subnet.subnetEmaTaoFlowDir} />}
          />

          <Row label="Moving price" value={subnet.subnetMovingPrice} />
        </div>

        <div className="mt-5 flex gap-2">
          <a
            href={`/api/subnets/${id}/identity`}
            className="rounded-xl bg-white/10 hover:bg-white/15 border border-white/10 px-4 py-2 text-sm"
          >
            Identity JSON
          </a>

          <a
            href="/api/subnets"
            className="rounded-xl bg-white/10 hover:bg-white/15 border border-white/10 px-4 py-2 text-sm"
          >
            Subnets JSON
          </a>
        </div>
      </div>
    </main>
  );
}
