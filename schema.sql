-- Rooms: a match between two players
create table rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  player1_id uuid not null,
  player1_name text not null,
  player2_id uuid,
  player2_name text,
  status text not null default 'waiting'
    check (status in ('waiting', 'ready', 'playing', 'finished')),
  created_at timestamptz not null default now()
);

alter table rooms enable row level security;

create policy "Rooms are viewable by everyone"
  on rooms for select using (true);

create policy "Anyone can create a room"
  on rooms for insert with check (true);

create policy "Anyone can update a room"
  on rooms for update using (true);

-- Enable Realtime for rooms
alter publication supabase_realtime add table rooms;

-- Profiles (optional, for future auth integration)
-- create table profiles (
--   id uuid references auth.users on delete cascade primary key,
--   display_name text not null,
--   created_at timestamptz not null default now()
-- );
