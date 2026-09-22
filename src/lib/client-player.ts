import { localPlayerId, usePlayerStore } from "@/store/player-store";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";

export async function requirePlayerId(): Promise<string> {
  await usePlayerStore.getState().ensurePlayer();
  const id = usePlayerStore.getState().playerId ?? localPlayerId();
  if (!id) throw new Error("暂时无法连接书院，请检查网络后重试。");
  return id;
}

export async function readGameView<T>(
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const playerId = await requirePlayerId();
  const response = await fetchWithTimeout(
    `${path}${path.includes("?") ? "&" : "?"}playerId=${encodeURIComponent(playerId)}`,
    { signal, cache: "no-store" },
  );
  if (!response.ok)
    throw new Error("这一页暂未载入，请稍后重试。已有进度会保留。");
  return response.json() as Promise<T>;
}
