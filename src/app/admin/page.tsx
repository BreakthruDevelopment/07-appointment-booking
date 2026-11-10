import type { Metadata } from "next";
import { DemoLoader } from "@/components/admin/demo-loader";
import { type Column, DataList, PageIntro, Panel, StatGrid, StatTile } from "@/components/ui";
import { type AdminUser, getAdminOverview, listUsers } from "@/lib/admin";
import { requireRoleOrRedirect } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const admin = await requireRoleOrRedirect("admin");
  const [overview, users] = await Promise.all([getAdminOverview(admin), listUsers(admin)]);

  const columns: Column<AdminUser>[] = [
    { key: "name", header: "Name", primary: true, cell: (u) => u.name },
    { key: "email", header: "Email", className: "break-all", cell: (u) => <span className="break-all">{u.email}</span> },
    {
      key: "role",
      header: "Role",
      cell: (u) => (u.role?.split(",").includes("admin") ? <span className="inline-flex rounded-md bg-accent-soft px-2 py-0.5 text-sm font-medium text-accent">Admin</span> : "User"),
    },
    { key: "joined", header: "Joined", className: "whitespace-nowrap", cell: (u) => u.createdAt.slice(0, 10) },
  ];

  const { chat, demo, bookings } = overview;
  return (
    <div data-admin>
      <PageIntro
        section="Admin"
        title="Overview"
        description="Counts only: no booking, note or message is shown here. Those belong to the customer and provider involved."
      />
      <StatGrid>
        <StatTile value={<span data-count="providers">{overview.providers}</span>} label={`Providers (${overview.acceptingProviders} accepting)`} tone="accent" />
        <StatTile value={<span data-count="services">{overview.services}</span>} label="Services" />
        <StatTile value={<span data-count="bookings-confirmed">{bookings.confirmed}</span>} label={`Confirmed bookings (${bookings.upcoming} upcoming)`} tone="live" />
        <StatTile value={<span data-count="bookings-cancelled">{bookings.cancelled}</span>} label="Cancelled bookings" />
      </StatGrid>

      <Panel title="Assistant usage today (UTC)">
        <dl className="grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-sm text-muted">Chat turns</dt>
            <dd className="font-display text-3xl font-semibold" data-count="chat-turns">
              {chat.turnsToday}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-muted">Model steps (tool calls included) of the daily cap</dt>
            <dd className="font-display text-3xl font-semibold" data-count="chat-steps">
              {chat.stepsToday} <span className="text-lg font-normal text-muted">of {chat.stepCap}</span>
            </dd>
          </div>
          <div>
            <dt className="text-sm text-muted">Cap used</dt>
            <dd className="pt-2">
              <meter className="h-3 w-full" min={0} max={chat.stepCap} value={Math.min(chat.stepsToday, chat.stepCap)} aria-label="Share of the daily model-step cap used" />
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-sm text-muted">Each turn reserves up to 4 model steps up front. Tool calls happen inside those steps and aren&apos;t stored, only counted in the logs.</p>
      </Panel>

      <Panel title="Demo workspace">
        <DemoLoader loadsLeft={Math.max(demo.loadCap - demo.loadsToday, 0)} />
      </Panel>

      <Panel title="Users" count={overview.users}>
        <DataList caption="Users" rows={users} rowKey={(u) => u.id} columns={columns} empty="No users yet." />
      </Panel>
    </div>
  );
}
