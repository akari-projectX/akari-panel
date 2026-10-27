-- 低-9: `device_seats` was stored for a seat binding that does not exist
-- (planned with the client); nothing reads or enforces it.
ALTER TABLE plans DROP COLUMN device_seats;
