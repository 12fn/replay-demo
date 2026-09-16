import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EvidenceRelations, type EvidenceRelationsProps } from '../../src/client/components/EvidenceRelations';

const packet: EvidenceRelationsProps['packet'] = {
  id: 'packet-1', reportId: 'report-1', sourceId: 'source-stable',
  entityId: 'entity-stable', observedTick: 4, releaseTick: 9,
  sourceRelationship: 'derivative',
  links: [
    { kind: 'derived-from', reportId: 'report-2' },
    { kind: 'disputes', reportId: 'missing-report' },
  ],
  lineageRootId: 'root-1', claimStatus: 'fictional-scenario-claim',
  authoritativeState: false,
};
const references = [{ id: 'report-2', title: 'Earlier field note' }];

function render(extra: Partial<EvidenceRelationsProps> = {}) {
  return renderToStaticMarkup(React.createElement(EvidenceRelations, {
    packet, references, ...extra,
  }));
}

describe('EvidenceRelations', () => {
  it('labels derivative fictional evidence without claiming corroboration', () => {
    const html = render();
    expect(html).toContain('Fictional scenario claim');
    expect(html).toContain('not measured game state');
    expect(html).toContain('repeated claim, not independent corroboration');
  });

  it('keeps observation and release ticks distinct', () => {
    const html = render();
    expect(html).toMatch(/Observed tick<\/dt><dd>4/);
    expect(html).toMatch(/Released tick<\/dt><dd>9/);
  });

  it('describes a dispute as unresolved and not adjudicated', () => {
    const html = render({ evidenceStatus: 'disputed' });
    expect(html).toContain('Unresolved conflict; not adjudicated.');
    expect(html).not.toMatch(/confirmed intelligence|factually correct/i);
  });

  it('suppresses missing references and deduplicates inferred links', () => {
    const html = render({ disputedWith: ['missing-report'], supersededBy: 'report-2' });
    expect(html).not.toContain('missing-report');
    expect(html).toContain('Earlier field note');
    expect(html.match(/Earlier field note/g)).toHaveLength(2);
  });

  it('does not invent status or an enabled button without a handler', () => {
    const html = render();
    expect(html).not.toContain('Packet status');
    expect(html).not.toContain('<button');
    expect(html).toContain('Earlier field note');
  });
});

it('does not imply that a non-derivative correction is independent corroboration',()=>{
 const html=render({packet:{...packet,sourceRelationship:'independent',links:[]}});
 expect(html).toContain('check source identity before treating it as independent corroboration');
 expect(html).not.toContain('Independent source relationship.');
});
