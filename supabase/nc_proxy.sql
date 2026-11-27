-- Proxy NguonC qua Supabase (chạy 1 lần trong SQL Editor).
-- Lý do: GitHub Actions runner bị Cloudflare chặn (HTTP 403 "Attention Required"),
-- còn IP nhà người dùng và (hy vọng) IP Supabase thì truy cập được.
-- Chỉ cho phép URL api của nguonc.com để tránh biến RPC thành open proxy.
--
-- Sau khi chạy, phần cuối file in status_code từ Supabase:
--   200 = dùng được; 403 = IP Supabase cũng bị chặn, cần hướng khác.

create extension if not exists pg_net with schema extensions;

create or replace function public.nc_http_request(p_url text)
returns bigint
language plpgsql
security definer
set search_path = public, net
as $$
begin
  if p_url is null or p_url !~ '^https://(phim\.)?nguonc\.com/api/' then
    raise exception 'URL nguonc.com không hợp lệ: %', p_url;
  end if;

  return net.http_get(
    url := p_url,
    headers := jsonb_build_object(
      'User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept', 'application/json, text/plain, */*',
      'Accept-Language', 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
      'Referer', 'https://phim.nguonc.com/',
      'Origin', 'https://phim.nguonc.com'
    ),
    timeout_milliseconds := 15000
  );
end;
$$;

create or replace function public.nc_http_result(p_id bigint)
returns table(status_code integer, content text, error_msg text)
language plpgsql
security definer
set search_path = public, net
as $$
declare
  _row net._http_response%rowtype;
begin
  for _i in 1..60 loop
    select * into _row from net._http_response where id = p_id limit 1;
    if found then
      return query select _row.status_code, _row.content, _row.error_msg;
      return;
    end if;
    perform pg_sleep(0.25);
  end loop;
  return query select 0, ''::text, 'timeout'::text;
end;
$$;

revoke all on function public.nc_http_request(text) from public, anon, authenticated;
revoke all on function public.nc_http_result(bigint) from public, anon, authenticated;
grant execute on function public.nc_http_request(text) to service_role;
grant execute on function public.nc_http_result(bigint) to service_role;
notify pgrst, 'reload schema';

-- Test: chạy từng lệnh cách nhau vài giây.
-- select public.nc_http_request('https://phim.nguonc.com/api/films/phim-moi-cap-nhat?page=1') as request_id;
-- select status_code, error_msg, left(content, 160) as content
-- from public.nc_http_result(<request_id>);
