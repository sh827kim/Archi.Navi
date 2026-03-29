import type { Metadata } from 'next';
import { DashboardHomeClient } from '@/components/dashboard/dashboard-home-client';

export const metadata: Metadata = {
  title: 'Dashboard Home',
};

export default function DashboardHomePage() {
  return <DashboardHomeClient />;
}
