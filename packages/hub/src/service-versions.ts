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
type Census = { observation: UpdateManager; withdrawn: boolean };

// Reads Config.Image without inventing a latest tag or treating a registry's
// port or a digest's colon as a tag (ADR-0022).
export const parseDockerImage = (image: string): ServiceVersion => {
  if (image.startsWith('sha256:') || /^[\da-f]{64}$/iu.test(image)) {
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

// Only confirmed installed versions count, even if package metadata could
// not be read. Freshness belongs to the census, not the pending-update check.
const packageVersion = (upstream: string | null, censuses: readonly Census[], now: number) => {
  for (const { observation, withdrawn } of censuses) {
    const census = observation.installed;
    if (withdrawn || census === undefined || !freshUpdateTime(census.observedAt, now)) {
      continue;
    }
    const match = census.versions?.find(({ name }) => {
      if (observation.manager === 'apt' && upstream?.startsWith('apt:')) {
        const prefix = `${upstream.slice(4)}:`;
        return name.startsWith(prefix) && name.length > prefix.length;
      }
      if (observation.manager === 'homebrew' && upstream?.startsWith('brew:')) {
        const formula = upstream.slice(5);
        return name === `formula:${formula}` || name === `cask:${formula}`;
      }
      return false;
    });
    if (match !== undefined) {
      return match.version;
    }
  }
  return null;
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
}): ServiceVersion => {
  const application = applications.find((record) => record.name === service.application);
  const upstream = application?.source ?? null;
  if (service.supervisor === 'docker') {
    const parsed =
      image === undefined ? { upstream: null, version: null } : parseDockerImage(image);
    return {
      upstream: service.application === undefined ? parsed.upstream : upstream,
      version: parsed.version,
    };
  }
  return {
    upstream,
    version: packageVersion(upstream, censuses, now) ?? application?.version ?? null,
  };
};

// The caller holds the System's row lock and has stored all Report sections.
// Missing Docker supervisor checks add no knowledge; a present check without
// an image does. Forgotten Services keep their history without adding rows.
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
  const managers: { observation: unknown; withdrawn: boolean }[] = await tx`
    SELECT observation, withdrawn FROM update_managers
    WHERE system = ${system} ORDER BY manager, installation
  `;
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
    SELECT ${system}, v->>'service', v->>'version', v->>'upstream', ${new Date(receivedAt)}
    FROM jsonb_array_elements(${storableJson(versions)}::text::jsonb) AS v
    LEFT JOIN LATERAL (
      SELECT version, upstream, first_seen_at FROM service_versions
      WHERE system = ${system} AND service = v->>'service'
      ORDER BY first_seen_at DESC LIMIT 1
    ) latest ON true
    WHERE latest.first_seen_at IS NULL
       OR (latest.version, latest.upstream) IS DISTINCT FROM (v->>'version', v->>'upstream')
    ON CONFLICT (system, service, first_seen_at) DO UPDATE SET
      version = excluded.version, upstream = excluded.upstream
  `;
};
