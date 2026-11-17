# Adding an account (POC)

This guide covers adding a route and its location-scoped API credentials to the proof of concept. Webhook registration and verification of the account's exact payload format remain manual.

1. **Get collaborator access.** Ask the client to add you to the required GHL account/location. Never request or store their password. Confirm the account ID, location ID, available API scopes, and test contact/pipeline.
2. **Confirm destination details.** Record the intended internal account ID, GHL location ID, and pipeline ID, plus which source, locations, and service types should route there. Agree on how conflicting contact fields should be handled; this POC preserves existing non-empty values.
3. **Add routing rules.** Edit [`../config/routing.json`](../config/routing.json). Add a specific rule before general wildcard rules. For example:

   ```json
   {
     "source": "google_ads",
     "location": "seattle",
     "service_type": "plumbing",
     "account_id": "brand-c",
     "pipeline_id": "plumbing-inbox"
   }
   ```

   Matching ignores letter case, and the most specific matching rule wins. Restart the service after editing the config.

4. **Add the location credential mapping.** In `.env`, add the account's location and the name of its token variable to `GHL_ACCOUNT_CONFIG_JSON`, then set that token variable to a Private Integration access token with `contacts.write`. Do not add tokens to `routing.json` or commit `.env`.
5. **Map and test an event.** Map the client's webhook payload to the POC event contract in the README. With `GHL_MODE=mock`, send a test event and verify its selected account/pipeline in `GET /leads`. When approved for live writes, set `GHL_MODE=real`, send a unique test event, verify the contact in the correct GHL location, and check `GET /sync-logs`.
6. **Before live use.** Register and verify approved GHL webhook/native triggers, test rate limits, retries, and field mappings, and confirm import/email verification and contact-company association features with the client. Keep credentials in an approved secret store, not in this repository.

Do not treat a successful mock sync as proof that the real account was updated. Confirm every live integration step with a test record in the client's account before enabling production traffic.
