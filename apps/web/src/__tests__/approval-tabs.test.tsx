// @vitest-environment jsdom

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('@archi-navi/ui', () => {
  const ReactLocal = React;
  const TabsContext = ReactLocal.createContext<{ value: string; setValue: (value: string) => void } | null>(null);
  return {
    Tabs: ({ defaultValue, children }: { defaultValue: string; children: React.ReactNode }) => {
      const [value, setValue] = ReactLocal.useState(defaultValue);
      return (
        <TabsContext.Provider value={{ value, setValue }}>
          <div data-value={value}>{children}</div>
        </TabsContext.Provider>
      );
    },
    TabsList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    TabsTrigger: ({ value, children }: { value: string; children: React.ReactNode }) => {
      const ctx = ReactLocal.useContext(TabsContext);
      return <button type="button" onClick={() => ctx?.setValue(value)}>{children}</button>;
    },
    TabsContent: ({ value, children }: { value: string; children: React.ReactNode }) => {
      const ctx = ReactLocal.useContext(TabsContext);
      return ctx?.value === value ? <div>{children}</div> : null;
    },
  };
});

vi.mock('@/components/approval/approval-list', () => ({
  ApprovalList: () => <div>relations-content</div>,
}));
vi.mock('@/components/approval/frontier-approval-list', () => ({
  FrontierApprovalList: () => <div>frontiers-content</div>,
}));
vi.mock('@/components/approval/domain-approval-list', () => ({
  DomainApprovalList: () => <div>domains-content</div>,
}));

import { ApprovalTabs } from '@/components/approval/approval-tabs';

describe('ApprovalTabs', () => {
  it('Frontiers 탭을 노출하고 전환할 수 있어야 한다', () => {
    render(<ApprovalTabs />);

    expect(screen.getByText('관계 후보')).toBeTruthy();
    expect(screen.getByText('Frontiers')).toBeTruthy();
    expect(screen.getByText('도메인 후보')).toBeTruthy();

    expect(screen.getByText('relations-content')).toBeTruthy();
    fireEvent.click(screen.getByText('Frontiers'));
    expect(screen.getByText('frontiers-content')).toBeTruthy();
  });
});
