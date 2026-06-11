#!/bin/bash

# Test script for API reference parameter fix
# This will start the dev server and test the API endpoint

echo "🧪 Testing API fix for reference parameter..."
echo ""
echo "Starting Netlify dev server..."
echo "After server starts, test in browser:"
echo ""
echo "1. Get a real reference from your database"
echo "2. Visit: http://localhost:8888/confirmation.html?ref=FM-XXXXXX"
echo "3. Check Network tab for: GET /api/bookings?reference=FM-XXXXXX"
echo "4. Should return: { bookings: [ { id: 1, reference: 'FM-XXXXXX', ... } ] }"
echo ""
echo "Press Ctrl+C to stop the server when done testing"
echo ""

cd ~/Downloads/funky-monkey-email && npx netlify dev
