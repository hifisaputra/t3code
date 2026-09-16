import * as Option from "effect/Option";

/**
 * A desktop distribution is a build of the app that installs and runs next to
 * the official one without touching its data. The build script stamps the id
 * into the packaged package.json; the runtime derives every name that would
 * otherwise collide from it: the data directory, the Electron user-data folder,
 * the bundle id, the product name, the renderer scheme and the Linux binary.
 * No id means the official names, so the default build is unchanged.
 */
export const DESKTOP_DISTRIBUTION_ENV = "T3CODE_DESKTOP_DISTRIBUTION";
export const DESKTOP_DISTRIBUTION_PACKAGE_FIELD = "t3codeDistribution";

// Lowercase words joined by single dashes. The id ends up in a URL scheme, a
// bundle id, a directory name and a file name, so it stays that simple.
const DESKTOP_DISTRIBUTION_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const OFFICIAL_BASE_NAME = "T3 Code";
const OFFICIAL_SLUG = "t3code";
const OFFICIAL_APP_ID = "com.t3tools.t3code";
const OFFICIAL_BASE_DIR_NAME = ".t3";

export function isDesktopDistributionId(value: string): boolean {
  return DESKTOP_DISTRIBUTION_ID_PATTERN.test(value);
}

export function normalizeDesktopDistributionId(value: unknown): Option.Option<string> {
  if (typeof value !== "string") return Option.none();
  const trimmed = value.trim();
  return isDesktopDistributionId(trimmed) ? Option.some(trimmed) : Option.none();
}

/** "fork" becomes "Fork", "tomo-dev" becomes "Tomo Dev". */
export function desktopDistributionLabel(distributionId: string): string {
  return distributionId
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export interface DesktopDistributionNames {
  readonly distributionId: Option.Option<string>;
  /** Product name without the stage suffix: "T3 Code" or "T3 Code Fork". */
  readonly baseName: string;
  /** Machine name used for the scheme, user-data folder and Linux binary. */
  readonly slug: string;
  /** macOS bundle id and Windows AppUserModelId. */
  readonly appId: string;
  /** Directory under the home directory that holds the server state. */
  readonly baseDirName: string;
  /** Prefix of installer file names. */
  readonly artifactPrefix: string;
}

export function resolveDesktopDistributionNames(
  distributionId: Option.Option<string>,
): DesktopDistributionNames {
  if (Option.isNone(distributionId)) {
    return {
      distributionId,
      baseName: OFFICIAL_BASE_NAME,
      slug: OFFICIAL_SLUG,
      appId: OFFICIAL_APP_ID,
      baseDirName: OFFICIAL_BASE_DIR_NAME,
      artifactPrefix: "T3-Code",
    };
  }
  const id = distributionId.value;
  return {
    distributionId,
    baseName: `${OFFICIAL_BASE_NAME} ${desktopDistributionLabel(id)}`,
    slug: `${OFFICIAL_SLUG}-${id}`,
    appId: `${OFFICIAL_APP_ID}.${id}`,
    baseDirName: `${OFFICIAL_BASE_DIR_NAME}-${id}`,
    artifactPrefix: `T3-Code-${id}`,
  };
}

/** The renderer origin scheme: t3code, t3code-dev, t3code-fork, t3code-fork-dev. */
export function desktopDistributionScheme(
  distributionId: Option.Option<string>,
  isDevelopment: boolean,
): string {
  const { slug } = resolveDesktopDistributionNames(distributionId);
  return isDevelopment ? `${slug}-dev` : slug;
}

/**
 * The id a running app should use. An environment variable wins so a dev run
 * can try a distribution without packaging; otherwise it is the field the build
 * wrote into the packaged package.json. Anything malformed counts as absent.
 */
export function resolveDesktopDistributionId(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readPackageJson: () => string | null;
}): Option.Option<string> {
  const fromEnv = normalizeDesktopDistributionId(input.env[DESKTOP_DISTRIBUTION_ENV]);
  if (Option.isSome(fromEnv)) return fromEnv;
  try {
    const raw = input.readPackageJson();
    if (raw === null) return Option.none();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return Option.none();
    return normalizeDesktopDistributionId(
      (parsed as Record<string, unknown>)[DESKTOP_DISTRIBUTION_PACKAGE_FIELD],
    );
  } catch {
    return Option.none();
  }
}
