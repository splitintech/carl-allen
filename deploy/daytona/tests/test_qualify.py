import importlib.util
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import qualify


class QualificationTest(unittest.TestCase):
    def test_signed_query_and_path_are_preserved(self):
        self.assertEqual(qualify.api_url('https://preview.invalid/?token=signed','v1/me'),'https://preview.invalid/v1/me?token=signed')
        with self.assertRaises(ValueError):qualify.api_url('http://preview.invalid','v1/me')

    def test_synthetic_success_is_rejected(self):
        case={'kind':'social.publish','accountId':'account'}
        result=qualify.verify_action(case,{'id':'a','kind':'social.publish','provider_account_id':'account','state':'succeeded','attempts':[{'receipt':{'providerMessageId':'linkedin:publish:a'}}]})
        self.assertFalse(result['passed']);self.assertIn('missing_native_receipt',result['failures'])

    def test_wrong_sender_and_native_confirmation_are_distinguished(self):
        case={'kind':'social.message','accountId':'a'}
        result=qualify.verify_action(case,{'id':'id','kind':'social.message','provider_account_id':'b','state':'succeeded','attempts':[{'receipt':{'providerMessageId':'urn:li:message:real'}}]})
        self.assertEqual(result['failures'],['account_mismatch'])
        result=qualify.verify_action(case,{'id':'id','kind':'social.message','provider_account_id':'a','state':'succeeded','attempts':[{'receipt':{'providerMessageId':'urn:li:message:real'}}]})
        self.assertTrue(result['passed'])


if __name__=='__main__':unittest.main()
