#!/usr/bin/env python3
"""
Test Kiro login bot with same credentials (for comparison)
"""
import asyncio
import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.providers.kiro import KiroProviderAdapter
from app.providers.base import NormalizedAccount


async def main():
    print("=" * 70)
    print("🧪 Kiro Login Bot Test (Non-Headless - Auto Mode)")
    print("=" * 70)
    
    # Test credentials
    email = "CayayahRatajaya@ggmel.com"
    password = "qwertyui"
    
    print(f"\n✅ Testing login for: {email}")
    print("⚠️  Browser will open in NON-HEADLESS mode")
    print("⚠️  Using REAL credentials")
    print("⏳ This will attempt full login flow...\n")
    
    # Set environment
    os.environ["BATCHER_ENABLE_CAMOUFOX"] = "true"
    os.environ["BATCHER_CAMOUFOX_HEADLESS"] = "false"
    os.environ["BATCHER_KIRO_AUTH_DEBUG"] = "true"
    
    # Create account
    account = NormalizedAccount(
        provider="kiro",
        identifier=email,
        secret=password,
        metadata={},
        raw=f"{email}|{password}"
    )
    
    # Create adapter
    adapter = KiroProviderAdapter()
    session = None
    
    try:
        # Bootstrap session (open browser)
        print("📍 Step 1: Opening browser...")
        session = await adapter.bootstrap_session(account)
        print("✅ Browser opened!")
        print(f"   Browser type: {type(session)}")
        print(f"   Session keys: {list(session.keys()) if isinstance(session, dict) else 'N/A'}\n")
        
        # Wait a bit to see the page
        print("⏳ Waiting 5 seconds to see the auth page...")
        await asyncio.sleep(5)
        
        # Authenticate
        print("\n📍 Step 2: Starting authentication with Google OAuth...")
        print("   (This will attempt to fill email/password)")
        auth_state = await adapter.authenticate(account, session)
        print(f"✅ Authentication completed!")
        print(f"   Auth state keys: {list(auth_state.keys())}")
        print(f"   Authorization code: {auth_state.get('authorization_code', 'N/A')[:50]}...\n")
        
        # Fetch tokens
        print("📍 Step 3: Exchanging auth code for tokens...")
        tokens = await adapter.fetch_tokens(account, auth_state, session)
        print(f"✅ Tokens obtained!")
        print(f"   Access token: {tokens.get('access_token', 'N/A')[:50]}...")
        print(f"   Refresh token: {tokens.get('refresh_token', 'N/A')[:50]}...\n")
        
        # Fetch quota
        print("📍 Step 4: Fetching quota...")
        quota = await adapter.fetch_quota(account, tokens, session)
        print(f"✅ Quota: {quota}\n")
        
        # Save result
        result = {
            "email": email,
            "success": True,
            "provider": "kiro",
            "tokens": {
                "access_token_length": len(tokens.get('access_token', '')),
                "refresh_token_length": len(tokens.get('refresh_token', ''))
            },
            "quota": quota,
        }
        
        with open("kiro-test-result.json", "w") as f:
            json.dump(result, f, indent=2)
        
        print("=" * 70)
        print("✅ Test completed!")
        print("💾 Result saved to: kiro-test-result.json")
        print("=" * 70)
        
    except Exception as e:
        print(f"\n❌ Error occurred: {type(e).__name__}")
        print(f"   Message: {str(e)[:200]}")
        
        # Save error result
        result = {
            "email": email,
            "success": False,
            "provider": "kiro",
            "error": str(e),
            "error_type": type(e).__name__
        }
        
        with open("kiro-test-result.json", "w") as f:
            json.dump(result, f, indent=2)
        
        print("\n💾 Error result saved to: kiro-test-result.json")
        
        import traceback
        print("\n📋 Full traceback:")
        traceback.print_exc()
        
    finally:
        # Cleanup
        if session:
            print("\n🧹 Cleaning up browser session...")
            try:
                await adapter.cleanup_session(session)
                print("✅ Cleanup done!")
            except Exception as e:
                print(f"⚠️  Cleanup error: {e}")


if __name__ == "__main__":
    asyncio.run(main())
