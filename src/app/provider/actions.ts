"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { errorInfo } from "@/lib/http";
import {
  deleteService,
  listHours,
  listOverrides,
  listServices,
  replaceHours,
  replaceOverrides,
  saveService,
  upsertProfile,
  getOwnProfile,
} from "@/lib/provider";

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string; status: number };
type Result<T> = Ok<T> | Err;

async function run<T>(work: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, ...(await work()) };
  } catch (err) {
    const info = errorInfo(err);
    if (info.status >= 500) throw err;
    return { ok: false, error: info.body.error, status: info.status };
  }
}

export async function saveProfileAction(input: unknown): Promise<Result<{ profile: Awaited<ReturnType<typeof upsertProfile>> }>> {
  return run(async () => {
    const profile = await upsertProfile(await requireUser(), input);
    revalidatePath("/provider");
    return { profile };
  });
}

export async function getProfileAction() {
  return run(async () => ({ profile: await getOwnProfile(await requireUser()) }));
}

export async function saveServiceAction(input: unknown) {
  return run(async () => {
    const service = await saveService(await requireUser(), input);
    revalidatePath("/provider");
    return { service };
  });
}

export async function deleteServiceAction(id: unknown) {
  return run(async () => {
    await deleteService(await requireUser(), id);
    revalidatePath("/provider");
    return {};
  });
}

export async function listServicesAction() {
  return run(async () => ({ services: await listServices(await requireUser()) }));
}

export async function replaceHoursAction(input: unknown) {
  return run(async () => {
    const hours = await replaceHours(await requireUser(), input);
    revalidatePath("/provider");
    return { hours };
  });
}

export async function listHoursAction() {
  return run(async () => ({ hours: await listHours(await requireUser()) }));
}

export async function replaceOverridesAction(input: unknown) {
  return run(async () => {
    const overrides = await replaceOverrides(await requireUser(), input);
    revalidatePath("/provider");
    return { overrides };
  });
}

export async function listOverridesAction() {
  return run(async () => ({ overrides: await listOverrides(await requireUser()) }));
}
