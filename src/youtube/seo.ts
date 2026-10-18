// SEO defaults for gaming uploads: per-game keyword packs, video-type templates and
// a generator that respects YouTube's limits (100-char titles, 5000-char
// descriptions, 500-char tags, max 15 hashtags, valid chapter lists).
import type { SeoProfile } from "../lib/settings";
import { formatTime } from "../lib/platform";

export interface GamePreset {
  id: string;
  name: string;
  tags: string[];
  hashtags: string[];
}

export const GAMES: GamePreset[] = [
  { id: "minecraft", name: "Minecraft", tags: ["minecraft", "minecraft survival", "minecraft let's play", "minecraft hardcore", "minecraft build", "mc"], hashtags: ["#minecraft", "#minecraftsurvival"] },
  { id: "fortnite", name: "Fortnite", tags: ["fortnite", "fortnite battle royale", "fortnite victory royale", "fortnite zero build", "fortnite chapter"], hashtags: ["#fortnite", "#fortniteclips"] },
  { id: "gta5", name: "GTA 5", tags: ["gta 5", "gta v", "gta online", "gta 5 rp", "grand theft auto"], hashtags: ["#gta5", "#gtaonline"] },
  { id: "gta6", name: "GTA 6", tags: ["gta 6", "gta vi", "grand theft auto 6", "gta 6 gameplay", "vice city"], hashtags: ["#gta6", "#gtavi"] },
  { id: "valorant", name: "Valorant", tags: ["valorant", "valorant ranked", "valorant clips", "valorant highlights", "valorant ace"], hashtags: ["#valorant", "#valorantclips"] },
  { id: "cod", name: "Call of Duty", tags: ["call of duty", "warzone", "cod", "black ops", "cod multiplayer", "warzone win"], hashtags: ["#callofduty", "#warzone"] },
  { id: "roblox", name: "Roblox", tags: ["roblox", "roblox funny moments", "roblox obby", "roblox games", "roblox gameplay"], hashtags: ["#roblox", "#robloxgames"] },
  { id: "lol", name: "League of Legends", tags: ["league of legends", "lol", "league ranked", "league highlights", "lol gameplay"], hashtags: ["#leagueoflegends", "#lol"] },
  { id: "apex", name: "Apex Legends", tags: ["apex legends", "apex ranked", "apex predator", "apex highlights", "apex legends gameplay"], hashtags: ["#apexlegends", "#apex"] },
  { id: "cs2", name: "Counter-Strike 2", tags: ["cs2", "counter strike 2", "cs2 highlights", "cs2 ranked", "csgo"], hashtags: ["#cs2", "#counterstrike"] },
  { id: "bgmi", name: "BGMI / PUBG", tags: ["bgmi", "pubg mobile", "pubg", "bgmi live", "chicken dinner", "bgmi gameplay"], hashtags: ["#bgmi", "#pubgmobile"] },
  { id: "freefire", name: "Free Fire", tags: ["free fire", "free fire max", "ff gameplay", "free fire booyah", "garena free fire"], hashtags: ["#freefire", "#freefiremax"] },
  { id: "eldenring", name: "Elden Ring", tags: ["elden ring", "elden ring boss", "elden ring guide", "elden ring dlc", "soulslike"], hashtags: ["#eldenring", "#soulslike"] },
  { id: "genshin", name: "Genshin Impact", tags: ["genshin impact", "genshin", "genshin pulls", "genshin build", "hoyoverse"], hashtags: ["#genshinimpact", "#genshin"] },
  { id: "fc", name: "EA Sports FC", tags: ["ea fc", "fc ultimate team", "fut", "ea sports fc", "football game"], hashtags: ["#eafc", "#fut"] },
  { id: "rocketleague", name: "Rocket League", tags: ["rocket league", "rocket league goals", "rocket league ranked", "rl clips"], hashtags: ["#rocketleague", "#rlclips"] },
  { id: "amongus", name: "Among Us", tags: ["among us", "among us impostor", "among us funny", "among us gameplay"], hashtags: ["#amongus", "#impostor"] },
  { id: "clash", name: "Clash Royale / CoC", tags: ["clash royale", "clash of clans", "supercell", "best deck", "attack strategy"], hashtags: ["#clashroyale", "#clashofclans"] },
  { id: "pokemon", name: "Pokémon", tags: ["pokemon", "pokemon gameplay", "shiny pokemon", "nuzlocke", "pokemon let's play"], hashtags: ["#pokemon", "#shinypokemon"] },
  { id: "other", name: "Other game", tags: [], hashtags: [] },
];

export interface VideoType {
  id: string;
  name: string;
  tags: string[];
  hooks: string[];
}

export const VIDEO_TYPES: VideoType[] = [
  { id: "letsplay", name: "Let's Play", tags: ["let's play", "playthrough", "gameplay", "no commentary"], hooks: ["This Changed Everything", "I Didn't Expect This", "The Journey Begins"] },
  { id: "walkthrough", name: "Walkthrough", tags: ["walkthrough", "guide", "full game", "100% walkthrough"], hooks: ["Full Walkthrough", "Step by Step Guide", "Complete Guide"] },
  { id: "highlights", name: "Highlights", tags: ["highlights", "best moments", "clips", "montage"], hooks: ["Best Moments", "Insane Plays", "Top Clips of the Week"] },
  { id: "funny", name: "Funny Moments", tags: ["funny moments", "funny", "fails", "epic fails"], hooks: ["We Couldn't Stop Laughing", "Funniest Moments Ever", "This Went Horribly Wrong"] },
  { id: "tips", name: "Tips & Tricks", tags: ["tips and tricks", "how to", "tutorial", "beginner guide", "pro tips"], hooks: ["Tips Pros Don't Tell You", "Get Better Fast", "Beginner to Pro"] },
  { id: "ranked", name: "Ranked", tags: ["ranked", "rank up", "competitive", "road to top"], hooks: ["Road to Top Rank", "Ranked Grind", "Carrying My Team"] },
  { id: "speedrun", name: "Speedrun", tags: ["speedrun", "any%", "world record", "fastest"], hooks: ["New Personal Best", "World Record Pace", "Fastest Run Ever"] },
  { id: "challenge", name: "Challenge", tags: ["challenge", "impossible challenge", "hardcore"], hooks: ["Impossible Challenge", "Can I Survive?", "Hardest Challenge Yet"] },
  { id: "review", name: "Review", tags: ["review", "is it worth it", "first impressions", "honest review"], hooks: ["Is It Worth It?", "Honest Review", "First Impressions"] },
  { id: "news", name: "Update / News", tags: ["new update", "patch notes", "season", "news"], hooks: ["New Update Explained", "Everything New", "Huge Changes"] },
  { id: "short", name: "Short clip", tags: ["shorts", "short", "clip"], hooks: ["Wait For It", "Did That Just Happen?", "Clean"] },
];

export const GENERIC_GAMING_TAGS = ["gaming", "gameplay", "gamer", "video games", "pc gaming"];

export interface MetaInput {
  game: GamePreset;
  customGame: string;
  type: VideoType;
  episode: number;
  hook: string;
  notes: string;
  markers: { time: number; label: string }[];
  duration: number;
  vertical: boolean;
  profile: SeoProfile;
}

export interface Metadata {
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
}

export const isShort = (duration: number, vertical: boolean) => vertical && duration > 0 && duration <= 180;

/** Valid YouTube chapters: start at 0:00, ≥3 entries, each ≥10 s long. */
export function chapters(markers: { time: number; label: string }[], duration: number): string[] {
  const sorted = [...markers].sort((a, b) => a.time - b.time);
  const list: { time: number; label: string }[] = [{ time: 0, label: "Intro" }];
  for (const m of sorted) {
    if (m.time - list[list.length - 1].time >= 10 && (duration <= 0 || duration - m.time >= 10)) list.push(m);
    else if (m.time < 10 && list.length === 1) list[0] = { time: 0, label: m.label || "Intro" };
  }
  if (list.length < 3) return [];
  return list.map((c) => `${formatTime(c.time)} ${c.label}`);
}

/** YouTube counts the 500-char tag budget with commas and quotes around multi-word tags. */
export function fitTags(tags: string[], budget = 480): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const raw of tags) {
    const t = raw.trim().replace(/[<>]/g, "").slice(0, 100);
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    const cost = t.length + (t.includes(" ") ? 2 : 0) + (out.length ? 1 : 0);
    if (used + cost > budget) continue;
    seen.add(key);
    used += cost;
    out.push(t);
  }
  return out;
}

export function fillTemplate(tpl: string, vars: Record<string, string>) {
  return tpl
    .replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "")
    .replace(/#\s*(?=\s|\||$)/g, "") // drop "#" when {episode} is empty
    .replace(/\s*\|\s*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function generateMetadata(i: MetaInput): Metadata {
  const gameName = i.game.id === "other" ? i.customGame.trim() || "Gameplay" : i.game.name;
  const short = isShort(i.duration, i.vertical);
  const hashtags = [
    ...(short ? ["#shorts"] : []),
    ...i.game.hashtags,
    ...i.profile.defaultHashtags.split(/\s+/).filter((h) => h.startsWith("#")),
    ...(i.game.id === "other" && gameName ? [`#${gameName.replace(/[^\w]/g, "").toLowerCase()}`] : []),
  ].filter((h, idx, a) => h.length > 1 && a.findIndex((x) => x.toLowerCase() === h.toLowerCase()) === idx).slice(0, 15);

  let title = fillTemplate(i.profile.titleTemplate || "{game} {type} #{episode} | {hook}", {
    game: gameName,
    type: i.type.name,
    episode: i.episode > 0 ? String(i.episode) : "",
    hook: i.hook,
    channel: i.profile.channelName,
  });
  if (short && !/#shorts/i.test(title)) title = `${title} #shorts`;
  if (title.length > 100) title = title.slice(0, 97).trimEnd() + "...";

  const chap = chapters(i.markers, i.duration);
  const lines = [
    `${i.hook ? `${i.hook} — ` : ""}${gameName} ${i.type.name.toLowerCase()}${i.episode ? ` episode ${i.episode}` : ""}.`,
    i.notes.trim(),
    "",
    ...(chap.length ? ["⏱ Chapters", ...chap, ""] : []),
    i.profile.descriptionFooter,
    ...(i.profile.socials.trim() ? ["", "🔗 Follow me", i.profile.socials.trim()] : []),
    "",
    hashtags.join(" "),
  ];
  const description = lines.join("\n").replace(/\n{3,}/g, "\n\n").slice(0, 4900);

  const tags = fitTags([
    gameName,
    `${gameName} ${i.type.name.toLowerCase()}`,
    `${gameName} gameplay`,
    ...(i.episode ? [`${gameName} episode ${i.episode}`] : []),
    ...i.game.tags,
    ...i.type.tags,
    ...i.profile.defaultTags.split(","),
    ...GENERIC_GAMING_TAGS,
    ...(short ? ["shorts", `${gameName} shorts`] : []),
    ...(i.profile.channelName ? [i.profile.channelName] : []),
  ]);

  return { title, description, tags, categoryId: "20" }; // 20 = Gaming
}
