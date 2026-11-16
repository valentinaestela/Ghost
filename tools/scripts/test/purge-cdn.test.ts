import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { buildMatrix } from '../release/build-publish-matrix.ts';
import {
  cdnRelease,
  purgeRelease,
  readCdnReleases,
  type CdnRelease,
  type Network,
} from '../release/purge-cdn.ts';

const PORTAL_URL = 'https://cdn.jsdelivr.net/ghost/portal@~2.72/umd/portal.min.js';
const PORTAL: CdnRelease = { package: '@tryghost/portal', version: '2.72.35', urls: [PORTAL_URL] };

interface FakeOptions {
  /** How many times npm is asked before it lists the release. */
  npmListsAfter?: number;
  /** How many times jsDelivr resolves an alias to the previous version after npm lists the release. */
  staleResolves?: number;
  /** The version jsDelivr resolves an alias to once it sees the release. */
  resolvesTo?: string;
  throttled?: boolean;
  /** The release left the file as it was, so jsDelivr goes on reporting the previous version for it. */
  fileUnchanged?: boolean;
}

/**
 * npm and jsDelivr as the purge meets them. jsDelivr resolves an alias the
 * first time a URL is asked for after a purge, from what npm lists at that
 * moment, and serves that answer until the next purge.
 */
function fakeNetwork({
  npmListsAfter = 0,
  staleResolves = 0,
  resolvesTo = '2.72.35',
  throttled = false,
  fileUnchanged = false,
}: FakeOptions = {}) {
  const events: string[] = [];
  const cached = new Map<string, string>();
  let npmAsked = 0;
  let staleLeft = staleResolves;
  const npmLists = () => npmAsked > npmListsAfter;

  const network: Network = {
    sleep: async () => {},
    fetch: async (url, init) => {
      const { hostname, pathname } = new URL(url);
      if (hostname === 'registry.npmjs.org') {
        npmAsked += 1;
        events.push(npmLists() ? 'npm: listed' : 'npm: not listed');
        const versions = npmLists() ? { '2.72.34': {}, '2.72.35': {} } : { '2.72.34': {} };
        return Response.json({ versions });
      }
      if (hostname === 'purge.jsdelivr.net') {
        events.push(`purge ${pathname}`);
        cached.delete(pathname);
        return Response.json({ status: 'finished', paths: { [pathname]: { throttled } } });
      }
      assert.strictEqual(init?.method, 'HEAD');
      const etagOf = (version: string) => (fileUnchanged ? '"same"' : `"${version}"`);
      const pinned = /@(\d+\.\d+\.\d+)\//.exec(pathname)?.[1];
      if (pinned) {
        return new Response(null, { headers: { 'x-jsd-version': pinned, etag: etagOf(pinned) } });
      }
      let version = cached.get(pathname);
      if (!version) {
        version = '2.72.34';
        if (npmLists() && staleLeft === 0 && !fileUnchanged) {
          version = resolvesTo;
        } else if (npmLists() && staleLeft > 0) {
          staleLeft -= 1;
        }
        cached.set(pathname, version);
      }
      return new Response(null, { headers: { 'x-jsd-version': version, etag: etagOf(version) } });
    },
  };

  return {
    network,
    events,
    purges: () => events.filter((event) => event.startsWith('purge ')).length,
    serves: (url: string) => cached.get(new URL(url).pathname),
  };
}

describe('purging a release', () => {
  it('waits for npm to list the release, then purges', async () => {
    const cdn = fakeNetwork({ npmListsAfter: 3 });

    await purgeRelease(PORTAL, cdn.network);

    assert.deepStrictEqual(cdn.events, [
      'npm: not listed',
      'npm: not listed',
      'npm: not listed',
      'npm: listed',
      'purge /ghost/portal@~2.72/umd/portal.min.js',
    ]);
    assert.strictEqual(cdn.serves(PORTAL_URL), '2.72.35');
  });

  it('purges again while jsDelivr still serves the previous version', async () => {
    const cdn = fakeNetwork({ staleResolves: 2 });

    await purgeRelease(PORTAL, cdn.network);

    assert.strictEqual(cdn.purges(), 3);
    assert.strictEqual(cdn.serves(PORTAL_URL), '2.72.35');
  });

  it('fails when jsDelivr never serves the release', async () => {
    const cdn = fakeNetwork({ staleResolves: Infinity });

    await assert.rejects(purgeRelease(PORTAL, cdn.network), /serves 2\.72\.34, not 2\.72\.35/);
  });

  it('fails without purging when npm never lists the release', async () => {
    const cdn = fakeNetwork({ npmListsAfter: Infinity });

    await assert.rejects(
      purgeRelease(PORTAL, cdn.network),
      /npm never listed @tryghost\/portal@2\.72\.35/,
    );
    assert.strictEqual(cdn.purges(), 0);
  });

  it('accepts a later release than its own, published while it waited', async () => {
    const cdn = fakeNetwork({ resolvesTo: '2.72.36' });

    await purgeRelease(PORTAL, cdn.network);

    assert.strictEqual(cdn.purges(), 1);
  });

  it("accepts a file the release didn't change, which jsDelivr reports as the previous version", async () => {
    const cdn = fakeNetwork({ fileUnchanged: true });

    await purgeRelease(PORTAL, cdn.network);

    assert.strictEqual(cdn.purges(), 1);
    assert.strictEqual(cdn.serves(PORTAL_URL), '2.72.34');
  });

  it('fails when jsDelivr throttles the purge', async () => {
    const cdn = fakeNetwork({ throttled: true });

    await assert.rejects(purgeRelease(PORTAL, cdn.network), /throttled/);
  });

  it('moves every URL of the release', async () => {
    const styles = 'https://cdn.jsdelivr.net/ghost/portal@~2.72/umd/main.css';
    const cdn = fakeNetwork();

    await purgeRelease({ ...PORTAL, urls: [PORTAL_URL, styles] }, cdn.network);

    assert.strictEqual(cdn.serves(PORTAL_URL), '2.72.35');
    assert.strictEqual(cdn.serves(styles), '2.72.35');
  });
});

describe('recording a release', () => {
  it("puts the release's major.minor into the URLs the publish matrix hands over", () => {
    const [portal] = buildMatrix(['@tryghost/portal']);
    assert.ok(portal);

    assert.deepStrictEqual(cdnRelease(portal.package_name, '9.4.1', portal.cdn_paths), {
      package: '@tryghost/portal',
      version: '9.4.1',
      urls: ['https://cdn.jsdelivr.net/ghost/portal@~9.4/umd/portal.min.js'],
    });
  });

  it('refuses a URL jsDelivr does not serve', () => {
    assert.throws(
      () => cdnRelease('@tryghost/portal', '2.72.35', 'https://example.com/portal.min.js'),
      /which jsDelivr doesn't serve/,
    );
  });

  it('refuses a prerelease, which no alias resolves to', () => {
    assert.throws(
      () => cdnRelease('@tryghost/shade', '0.1.0-alpha.3', PORTAL_URL),
      /not a stable version/,
    );
  });

  it('is read back from every artifact downloaded into a folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'purge-cdn-'));
    const search: CdnRelease = {
      package: '@tryghost/sodo-search',
      version: '1.8.4',
      urls: ['https://cdn.jsdelivr.net/ghost/sodo-search@~1.8/umd/sodo-search.min.js'],
    };
    try {
      await mkdir(join(dir, 'cdn-release-0'));
      await writeFile(join(dir, 'cdn-release-0', 'release.json'), JSON.stringify(PORTAL));
      await mkdir(join(dir, 'cdn-release-1'));
      await writeFile(join(dir, 'cdn-release-1', 'release.json'), JSON.stringify(search));

      assert.deepStrictEqual(await readCdnReleases(dir), [PORTAL, search]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the workflows', () => {
  it('download the release records under the name the publish job uploads them', async () => {
    const workflows = resolve(import.meta.dirname, '../../../.github/workflows');
    const publish = await readFile(join(workflows, 'ci.yml'), 'utf8');
    const purge = await readFile(join(workflows, 'purge-cdn.yml'), 'utf8');

    assert.match(publish, /name: cdn-release-\$\{\{ strategy\.job-index \}\}/);
    assert.match(purge, /grep -c '\^cdn-release-'/);
    assert.match(purge, /--pattern 'cdn-release-\*'/);
  });
});
