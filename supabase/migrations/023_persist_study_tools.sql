begin;

alter table public.study_assets
  drop constraint study_assets_kind_check;

alter table public.study_assets
  add constraint study_assets_kind_check
  check (kind in ('note', 'deck', 'quiz', 'concept'));

-- Concept maps retain the complete checked graph.
alter table public.study_assets
  drop constraint study_assets_data_check;

alter table public.study_assets
  add constraint study_assets_data_check check (
    jsonb_typeof(data) = 'array'
    and octet_length(data::text) <=
      case when kind = 'concept' then 150002 else 120000 end
  );

-- Prevent repeated completion/cache writes from creating duplicate materials.
create table private.study_tool_assets (
  source_id uuid not null
    references public.study_assets(id) on delete cascade,
  tool text not null,
  input_hash text not null,
  asset_id uuid not null
    references public.study_assets(id) on delete cascade,
  primary key (source_id, tool, input_hash)
);

alter table private.study_tool_assets enable row level security;
revoke all on private.study_tool_assets from public, anon, authenticated;

create function private.save_tool_material()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  source public.study_assets;
  saved_id uuid;
  payload jsonb;
begin
  if new.output #>> '{verification,version}' is distinct from '2' then
    return new;
  end if;

  select * into source
  from public.study_assets
  where id = new.asset_id;

  if source.id is null
     or not private.generation_editor(source.folder_id, new.created_by) then
    raise exception 'Editor access required';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(new.asset_id::text || new.tool || new.input_hash, 0)
  );

  if exists (
    select 1 from private.study_tool_assets
    where source_id = new.asset_id
      and tool = new.tool
      and input_hash = new.input_hash
  ) then
    return new;
  end if;

  if new.tool = 'highlights' then
    select jsonb_agg(
      jsonb_build_object(
        'id', gen_random_uuid(),
        'front', card ->> 'front',
        'back', card ->> 'back'
      ) order by ord
    )
    into payload
    from jsonb_array_elements(new.output -> 'cards')
      with ordinality as c(card, ord);
  else
    payload := jsonb_build_array(new.output);
  end if;

  insert into public.study_assets (
    folder_id, kind, title, data, created_by, is_custom
  )
  values (
    source.folder_id,
    case when new.tool = 'highlights' then 'deck' else 'concept' end,
    left(source.title, 120) ||
      case when new.tool = 'highlights'
        then ' · Highlights' else ' · Concept Map' end,
    payload,
    new.created_by,
    new.tool = 'highlights'
  )
  returning id into saved_id;

  insert into private.study_tool_assets
  values (new.asset_id, new.tool, new.input_hash, saved_id);

  return new;
end;
$$;

revoke all on function private.save_tool_material()
  from public, anon, authenticated;

create trigger save_tool_material
after insert or update of output on private.study_tool_results
for each row execute function private.save_tool_material();

-- Preserve currently cached, verified results as dashboard materials too.
update private.study_tool_results r
set output = r.output
from public.study_assets a
where a.id = r.asset_id
  and r.output #>> '{verification,version}' = '2'
  and private.generation_editor(a.folder_id, r.created_by);

commit;
