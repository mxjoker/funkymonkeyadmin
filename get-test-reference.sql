-- Get recent booking references for testing
-- Run this in your Neon SQL console or via psql

SELECT 
  reference, 
  client_email, 
  client_name,
  service_name, 
  status,
  created_at
FROM bookings 
ORDER BY created_at DESC 
LIMIT 5;
