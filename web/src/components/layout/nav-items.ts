import { MessageCircle, Clock4, BrainCircuit, Settings } from 'lucide-react';

interface NavItem {
  path: string;
  icon: typeof MessageCircle;
  label: string;
  hideOnMobile?: boolean;
}

export const baseNavItems: NavItem[] = [
  { path: '/chat', icon: MessageCircle, label: '工作台' },
  { path: '/tasks', icon: Clock4, label: '任务' },
  { path: '/memory', icon: BrainCircuit, label: '记忆', hideOnMobile: true },
  { path: '/settings', icon: Settings, label: '设置' },
];

export const navItems = baseNavItems;
