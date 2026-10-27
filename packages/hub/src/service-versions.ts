import { freshUpdateTime, REPORTED_RECORD_SCHEMAS, UpdateManagerSchema } from '@heimdall/schema';
import type {
  ApplicationRecord,
  ServiceCheck,
  ServiceRecord,
  UpdateManager,
} from '@heimdall/schema';
import type { SQL } from 'bun';

import { storableJson } from './storable.ts';

type ServiceVersion = { version: string | null; upstream: string | null };
// `censusLapsed` marks an `apt:` or `brew:` upstream whose package manager the
// System has reported, but with no fresh census now, so the version fell back
// to the recorded one only for the moment.
type DerivedVersion = ServiceVersion & { censusLapsed: boolean };
type Census = { observation: UpdateManager; withdrawn: boolean };

// Reads Config.Image without inventing a latest tag or treating a registry's
// port or a digest's colon as a tag (ADR-0022).
export const parseDockerImage = (image: string): ServiceVersion => {
  // A full or short image ID names no repository.
  if (image.startsWith('sha256:') || /^[\da-f]{12,64}$/iu.test(image)) {
    return { upstream: null, version: null };
  }
  const reference = image.split('@')[0] ?? '';
  const colon = reference.lastIndexOf(':');
  const tagged = colon > reference.lastIndexOf('/');
  const version = tagged ? reference.slice(colon + 1) : null;
  const repository = tagged ? reference.slice(0, colon) : reference;
  const slash = repository.indexOf('/');
  const first = repository.slice(0, slash);
  const explicitRegistry =
    slash !== -1 && (first.includes('.') || first.includes(':') || first === 'localhost');
  const registry = explicitRegistry && first !== 'index.docker.io' ? first : 'docker.io';
  let path = explicitRegistry ? repository.slice(slash + 1) : repository;
  if (registry === 'docker.io' && !path.includes('/')) {
    path = `library/${path}`;
  }
  return { upstream: `oci:${registry}/${path}`, version };
};

// The package manager whose census can supersede an upstream's recorded version.
const censusManager = (upstream: string | null) => {
  if (upstream?.startsWith('apt:')) {
    return 'apt';
  }
  return upstream?.startsWith('brew:') ? 'homebrew' : undefined;
};

// Only confirmed installed versions count, even if package metadata could
// not be read. Freshness belongs to the census, not the pending-update check.
// `lapsed` says the upstream's package manager was reported, but no census of
// it is fresh.
const packageVersion = (upstream: string | null, censuses: readonly Census[], now: number) => {
  const manager = censusManager(upstream);
  let reported = false;
  let covered = false;
  for (const { observation, withdrawn } of censuses) {
    const census = observation.installed;
    if (upstream === null || observation.manager !== manager) {
      continue;
    }
    reported = true;
    if (withdrawn || census === undefined || !freshUpdateTime(census.observedAt, now)) {
      continue;
    }
    covered = true;
    const match = census.versions?.find(({ name }) => {
      if (manager === 'apt') {
        const prefix = `${upstream.slice(4)}:`;
        return name.startsWith(prefix) && name.length > prefix.length;
      }
      const formula = upstream.slice(5);
      return name === `formula:${formula}` || name === `cask:${formula}`;
    });
    if (match !== undefined) {
      return { lapsed: false, version: match.version };
    }
  }
  return { lapsed: reported && !covered, version: null };
};

// Applications are from this Service's System; a named but missing one never
// falls back to the image's upstream (ADR-0022).
export const deriveServiceVersion = ({
  applications,
  censuses = [],
  image,
  now,
  service,
}: {
  applications: readonly ApplicationRecord[];
  censuses?: readonly Census[];
  image?: ServiceCheck['image'];
  now: number;
  service: ServiceRecord;
}): DerivedVersion => {
  const application = applications.find((record) => record.name === service.application);
  const upstream = application?.source ?? null;
  if (service.supervisor === 'docker') {
    const parsed =
      image === undefined ? { upstream: null, version: null } : parseDockerImage(image);
    return {
      censusLapsed: false,
      upstream: service.application === undefined ? parsed.upstream : upstream,
      version: parsed.version,
    };
  }
  const observed = packageVersion(upstream, censuses, now);
  return {
    censusLapsed: observed.lapsed,
    upstream,
    version: observed.version ?? application?.version ?? null,
  };
};

// The caller holds the System's row lock and has stored all Report sections.
// Missing Docker supervisor checks add no knowledge; a present check without
// an image does. A version read while its census has lapsed is written only as
// a Service's first row, so a census that lapses and returns records no
// install. A row is never dated before the latest, so a Hub clock that steps
// back still adds the newest value last. Forgotten Services keep their
// history without adding rows.
export const storeServiceVersions = async (
  tx: SQL,
  { receivedAt, system }: { receivedAt: number; system: string },
) => {
  const records: { kind: string; record: unknown }[] = await tx`
    SELECT kind, record FROM mirrored_records
    WHERE system = ${system} AND kind IN ('application', 'service')
  `;
  const applications: ApplicationRecord[] = [];
  const services: ServiceRecord[] = [];
  // A stored record this Hub cannot read is left out, as drift and job
  // Conditions leave it out, rather than failing the Report.
  for (const { kind, record } of records) {
    if (kind === 'application') {
      const parsed = REPORTED_RECORD_SCHEMAS.application.safeParse(record);
      if (parsed.success) {
        applications.push(parsed.data);
      }
    } else {
      const parsed = REPORTED_RECORD_SCHEMAS.service.safeParse(record);
      if (parsed.success) {
        services.push(parsed.data);
      }
    }
  }
  if (services.length === 0) {
    return;
  }
  const [checks]: { services: ServiceCheck[] | null }[] = await tx`
    SELECT services FROM check_sets WHERE system = ${system}
  `;
  // A census can be large, so it is read only for a Service it can supersede.
  const censused = services.some(
    (service) =>
      service.supervisor !== 'docker' &&
      censusManager(
        applications.find((record) => record.name === service.application)?.source ?? null,
      ) !== undefined,
  );
  const managers: { observation: unknown; withdrawn: boolean }[] = censused
    ? await tx`
        SELECT observation, withdrawn FROM update_managers
        WHERE system = ${system} ORDER BY manager, installation
      `
    : [];
  const censuses = managers.flatMap(({ observation, withdrawn }) => {
    const parsed = UpdateManagerSchema.safeParse(observation);
    return parsed.success ? [{ observation: parsed.data, withdrawn }] : [];
  });
  const versions = services.flatMap((service) => {
    const supervisor = checks?.services?.find(
      (check) => check.service === service.name && check.check === 'supervisor',
    );
    if (service.supervisor === 'docker' && supervisor === undefined) {
      return [];
    }
    return [
      {
        ...deriveServiceVersion({
          applications,
          censuses,
          image: supervisor?.image,
          now: receivedAt,
          service,
        }),
        service: service.name,
      },
    ];
  });
  await tx`
    INSERT INTO service_versions (system, service, version, upstream, first_seen_at)
    SELECT ${system}, v->>'service', v->>'version', v->>'upstream',
           CASE WHEN ${new Date(receivedAt)}::timestamptz < latest.first_seen_at
                THEN latest.first_seen_at + interval '1 millisecond'
                ELSE ${new Date(receivedAt)}::timestamptz END
    FROM jsonb_array_elements(${storableJson(versions)}::text::jsonb) AS v
    LEFT JOIN LATERAL (
      SELECT version, upstream, first_seen_at FROM service_versions
      WHERE system = ${system} AND service = v->>'service'
      ORDER BY first_seen_at DESC LIMIT 1
    ) latest ON true
    WHERE latest.first_seen_at IS NULL
       OR (NOT (v->>'censusLapsed')::boolean
           AND (latest.version, latest.upstream) IS DISTINCT FROM (v->>'version', v->>'upstream'))
    ON CONFLICT (system, service, first_seen_at) DO UPDATE SET
      version = excluded.version, upstream = excluded.upstream
  `;
};
