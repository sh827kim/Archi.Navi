/**
 * 승인 대기 탭 컨테이너
 * "관계 후보" / "도메인 후보" 탭 전환
 */
'use client';

import { Tabs, TabsList, TabsTrigger, TabsContent } from '@archi-navi/ui';
import { ApprovalList } from './approval-list';
import { DomainApprovalList } from './domain-approval-list';
import { FrontierApprovalList } from './frontier-approval-list';

export function ApprovalTabs() {
  return (
    <Tabs defaultValue="relations">
      <TabsList className="mb-4">
        <TabsTrigger value="relations">관계 후보</TabsTrigger>
        <TabsTrigger value="frontiers">Frontiers</TabsTrigger>
        <TabsTrigger value="domains">도메인 후보</TabsTrigger>
      </TabsList>

      <TabsContent value="relations">
        <ApprovalList />
      </TabsContent>

      <TabsContent value="frontiers">
        <FrontierApprovalList />
      </TabsContent>

      <TabsContent value="domains">
        <DomainApprovalList />
      </TabsContent>
    </Tabs>
  );
}
