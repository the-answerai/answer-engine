import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createWebComposition } from './composition';

describe('web composition contract', () => {
  afterEach(cleanup);

  it('rejects contributions that reference an undeclared capability', () => {
    expect(() => createWebComposition({
      routes: [{ id: 'fixture.route', path: '/fixture', capabilityId: 'fixture.missing', element: <div /> }],
    })).toThrow('unknown capability fixture.missing');
  });

  it('rejects extension routes that replace an OSS-owned route', () => {
    expect(() => createWebComposition({
      capabilities: [{ id: 'fixture.manage', label: 'Fixture management', family: 'teams' }],
      authorization: { decide: () => ({ allowed: true }) },
      routes: [{ id: 'fixture.route', path: '/content', capabilityId: 'fixture.manage', element: <div /> }],
    })).toThrow('conflicts with an OSS core route');
  });

  it('uses a fixture policy to hide unauthorized navigation and settings contributions', async () => {
    const composition = createWebComposition({
      capabilities: [
        { id: 'fixture.allowed', label: 'Allowed fixture', family: 'teams' },
        { id: 'fixture.denied', label: 'Denied fixture', family: 'permissions' },
      ],
      authorization: { decide: ({ capabilityId }) => ({ allowed: capabilityId === 'fixture.allowed' }) },
      routes: [
        { id: 'fixture.allowed-route', path: '/fixture', capabilityId: 'fixture.allowed', element: <p>Allowed route</p> },
        { id: 'fixture.denied-route', path: '/hidden', capabilityId: 'fixture.denied', element: <p>Denied route</p> },
      ],
      navigation: [
        { id: 'fixture.allowed-nav', to: '/fixture', label: 'Fixture', capabilityId: 'fixture.allowed' },
        { id: 'fixture.denied-nav', to: '/hidden', label: 'Hidden', capabilityId: 'fixture.denied' },
      ],
      settings: [
        { id: 'fixture.allowed-settings', title: 'Fixture settings', capabilityId: 'fixture.allowed', element: <p>Allowed settings</p> },
        { id: 'fixture.denied-settings', title: 'Hidden settings', capabilityId: 'fixture.denied', element: <p>Denied settings</p> },
      ],
    });
    const identity = { subject: 'fixture-user', label: 'Fixture user' };
    const visible = composition.forIdentity(identity);

    expect(visible.navigation.map((item) => item.label)).toContain('Fixture');
    expect(visible.navigation.map((item) => item.label)).not.toContain('Hidden');
    render(<>{visible.settings.map((section) => <div key={section.id}>{section.element}</div>)}</>);
    expect(screen.getByText('Allowed settings')).toBeTruthy();
    expect(screen.queryByText('Denied settings')).toBeNull();
  });
});
