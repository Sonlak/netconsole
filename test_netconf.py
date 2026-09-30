#!/usr/bin/env python3
"""Test NETCONF SSH configuration loading with different formats."""

import subprocess
import tempfile
import os
import re

def run_nc_session(host, port, username, password, rpc_list):
    """Run multiple RPCs in one NETCONF SSH session."""
    
    hello = '''<?xml version="1.0" encoding="UTF-8"?>
<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
  <capabilities>
    <capability>urn:ietf:params:netconf:base:1.0</capability>
  </capabilities>
</hello>
]]>]]>
'''
    
    all_rpcs = hello + ''.join(rpc_list)
    
    with tempfile.NamedTemporaryFile(mode='w', suffix='.xml', delete=False, newline='\n') as f:
        f.write(all_rpcs)
        xml_path = f.name
    
    script = f'''#!/bin/bash
sshpass -p '{password}' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -T {username}@{host} -p {port} -s netconf < "{xml_path}"
'''
    
    with tempfile.NamedTemporaryFile(mode='w', suffix='.sh', delete=False) as f:
        f.write(script)
        script_path = f.name
    
    os.chmod(script_path, 0o700)
    
    try:
        result = subprocess.run(
            ['/bin/bash', script_path],
            capture_output=True,
            timeout=60,
        )
        return (result.stdout or b'').decode('utf-8', errors='replace').strip()
    finally:
        os.unlink(xml_path)
        os.unlink(script_path)

def test_formats():
    host = '10.10.20.102'
    port = 830
    username = 'netconsole'
    password = 'Admin@123'
    
    from xml.sax.saxutils import escape
    
    cmd = 'set interfaces ge-0/0/5 description NETCONF-FORMAT-TEST'
    
    tests = [
        ("configuration-text (format=text)", 
         '<rpc><load-configuration format="text"><configuration-text>' + escape(cmd) + '</configuration-text></load-configuration></rpc>\n]]>]]>\n'),
        
        ("configuration-set (format=text) - Junos extension",
         '<rpc><load-configuration format="text"><configuration-set>' + escape(cmd) + '</configuration-set></load-configuration></rpc>\n]]>]]>\n'),
        
        ("configuration-set (format=set)",
         '<rpc><load-configuration format="set"><configuration-set>' + escape(cmd) + '</configuration-set></load-configuration></rpc>\n]]>]]>\n'),
        
        ("configuration (hierarchical XML)",
         '<rpc><load-configuration><configuration><interfaces><interface><name>ge-0/0/5</name><description>NETCONF-XML-TEST</description></interface></interfaces></configuration></load-configuration></rpc>\n]]>]]>\n'),
    ]
    
    commit_rpc = '<rpc><commit-configuration/></rpc>\n]]>]]>\n'
    
    for name, rpc in tests:
        print("=" * 60)
        print(f"Test: {name}")
        print("=" * 60)
        
        full_rpc = rpc + commit_rpc
        
        result = run_nc_session(host, port, username, password, [full_rpc])
        
        if '<load-configuration-results>' in result:
            load_match = re.search(r'<load-configuration-results>(.*?)</load-configuration-results>', result, re.DOTALL)
            if load_match:
                load_result = load_match.group(1)
                if '<load-success' in load_result:
                    print("✅ Load SUCCESS")
                elif '<load-error-count>0</load-error-count>' in load_result:
                    print("✅ Load SUCCESS (0 errors)")
                else:
                    err_match = re.search(r'<error-message>([^<]+)</error-message>', load_result)
                    if err_match:
                        print(f"❌ Load FAILED: {err_match.group(1)}")
                    else:
                        print("❌ Load FAILED: Unknown error")
                        print(f"   Result: {load_result[:300]}")
        
        if '<commit-results>' in result or '<rpc-reply>' in result:
            if '<commit-success' in result or '<ok/>' in result:
                print("✅ Commit SUCCESS")
            else:
                print("❌ Commit status unclear")
        
        print()

if __name__ == '__main__':
    test_formats()
