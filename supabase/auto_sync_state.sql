-- Chạy 1 lần trong Supabase SQL Editor (project tlbumpjugtltznzuwqwt).
--
-- Lưu mốc "phim mới cập nhật" của 3 nguồn cho auto-sync.js. Đặt ở bảng RIÊNG,
-- không dùng app_settings vì mọi ghi vào app_settings (trừ site_version) đều làm
-- trigger touch_site_version() đổi cờ -> web tải lại danh sách không cần thiết.

create table if not exists public.auto_sync_state (
  id bigint primary key default 1,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.auto_sync_state (id, state)
values (1, '{}'::jsonb)
on conflict (id) do nothing;

-- Kiểm tra: select id, state, updated_at from public.auto_sync_state;
