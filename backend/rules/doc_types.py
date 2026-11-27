"""
SAP FI document-type master (client config, Client 500 — all 188 types).

One place that says, for every SAP document type (BLART):
  * what it is (client's description),
  * which ledger event it is (INVOICE, PAYMENT, CREDIT_MEMO, ...), and
  * whether a row of that type may be skipped when it carries no TDS at all.

``skip`` never hides a row that has a TDS section or TDS amount on it —
those are always validated. It only stops "TDS not deducted" noise on
documents where the company does not deduct TDS (payroll, customer side,
bank / treasury, balance uploads, CO allocations, goods movements, ...).

Doc types not listed here are classified UNKNOWN and validated in full.
"""

INVOICE = "INVOICE"
ADVANCE_PAYMENT = "ADVANCE_PAYMENT"
PAYMENT = "PAYMENT"
CREDIT_MEMO = "CREDIT_MEMO"
DEBIT_NOTE = "DEBIT_NOTE"
CLEARING = "CLEARING"
TRANSFER_POSTING = "TRANSFER_POSTING"
TDS_PAYMENT = "TDS_PAYMENT"
JOURNAL = "JOURNAL"
PROVISION = "PROVISION"
SUPPORTING = "SUPPORTING"

SKIP = True       # skip the row when it has no TDS section and no TDS amount
VALIDATE = False  # always run the TDS checks

# code: (description, event, skip)
DOC_TYPE_MASTER: dict[str, tuple[str, str, bool]] = {
    # ---- Vendor invoices ------------------------------------------------
    "RE": ("Vendor Inv. - Po", INVOICE, VALIDATE),
    "KR": ("Vendor Inv.  W/O Po", INVOICE, VALIDATE),
    "F1": ("IT Vendor Invoice", INVOICE, VALIDATE),
    "F2": ("UE Vendor Invoice", INVOICE, VALIDATE),
    "F3": ("Non-UE Vendor Invoic", INVOICE, VALIDATE),
    "FA": ("Vendor Self invoice", INVOICE, VALIDATE),
    "LQ": ("Vendor Inv.-Capital", INVOICE, VALIDATE),
    "LS": ("Vend Inv-Imp Customs", INVOICE, VALIDATE),
    "RH": ("Vend Inv-Imports", INVOICE, VALIDATE),
    "RP": ("Vendor Pipeline", INVOICE, VALIDATE),
    "ZU": ("VENDOR INV.O/h MLL", INVOICE, VALIDATE),
    "ZE": ("ITALY Vendor Inv", INVOICE, VALIDATE),
    "KS": ("Free serv coupons", INVOICE, VALIDATE),
    "KW": ("Warranty Vendor Invo", INVOICE, SKIP),
    "CA": ("Commission Liability", INVOICE, VALIDATE),
    "FE": ("Interest Expense", INVOICE, VALIDATE),
    "FT": ("Freight Inwards", INVOICE, VALIDATE),
    "FO": ("Freight Outwards", INVOICE, VALIDATE),

    # ---- Vendor advance -------------------------------------------------
    "KA": ("Vendor Down Payment", ADVANCE_PAYMENT, SKIP),

    # ---- Payments (vendor side) — same treatment as KZ --------------------
    "KZ": ("Vendor Payment", PAYMENT, VALIDATE),
    "CP": ("Capital Payments", PAYMENT, VALIDATE),
    "P1": ("Wire Tr. Payment", PAYMENT, VALIDATE),
    "P2": ("BOE Payment", PAYMENT, VALIDATE),
    "P3": ("Direct Remittance", PAYMENT, VALIDATE),
    "PC": ("Petty Cash Payments", PAYMENT, VALIDATE),
    "MC": ("Pmnt  Manual Cheques", PAYMENT, VALIDATE),
    "HU": ("Hundies-Payable/Rece", PAYMENT, VALIDATE),
    "XC": ("Trlo - Cash Payments", PAYMENT, VALIDATE),
    "XP": ("Trlo - Pmt Docs", PAYMENT, VALIDATE),
    "XQ": ("Trlo - Manual Ckq", PAYMENT, VALIDATE),
    "YC": ("Cfm Cash Pymnts", PAYMENT, VALIDATE),
    "YQ": ("Cfm Cheques Manual", PAYMENT, VALIDATE),
    "ZT": ("AR/AP ACH TRF (MUSA)", PAYMENT, VALIDATE),
    # ---- Bank movements / receipts — no TDS deduction by the company -------
    "BD": ("Direct Bank Debits", PAYMENT, SKIP),
    "BC": ("Direct Bank Credits", PAYMENT, SKIP),
    "CT": ("Cash- Atm Trx.", PAYMENT, SKIP),
    "XB": ("Trlo - Bank Debits", PAYMENT, SKIP),
    "YB": ("Cfm Bank Debits", PAYMENT, SKIP),
    "SK": ("Misc. Receipts", PAYMENT, SKIP),
    "I1": ("Incoming Payment", PAYMENT, SKIP),
    "DZ": ("Recpt. From Cust.", PAYMENT, SKIP),
    "XR": ("Trlo - Reciepts", PAYMENT, SKIP),
    "ZA": ("Receipts Reversal", PAYMENT, SKIP),
    "ZP": ("Recp Reversal MLDL", PAYMENT, SKIP),

    # ---- Vendor credit / debit notes --------------------------------------
    "KG": ("Vendor Credit Note", CREDIT_MEMO, VALIDATE),
    "KC": ("Ven. Credit Non GST", CREDIT_MEMO, VALIDATE),
    "F4": ("IT Vendor Credit Not", CREDIT_MEMO, VALIDATE),
    "F5": ("UE Vendor Credit Not", CREDIT_MEMO, VALIDATE),
    "F6": ("Non-UE Vendor Credit", CREDIT_MEMO, VALIDATE),
    "F8": ("Nota Cred/Deb For", CREDIT_MEMO, VALIDATE),
    "F9": ("nota Cred/Deb UE For", CREDIT_MEMO, VALIDATE),
    "AC": ("Retro Amend Credits", CREDIT_MEMO, VALIDATE),
    "ZW": ("Musa Warr Credits", CREDIT_MEMO, VALIDATE),
    "KN": ("Vendor Debit Note", DEBIT_NOTE, VALIDATE),
    "KD": ("Ven.Debit Non GSt", DEBIT_NOTE, VALIDATE),
    "LD": ("Dn Line Reject Debit", DEBIT_NOTE, VALIDATE),
    "AD": ("Retro Amend Debits", DEBIT_NOTE, VALIDATE),

    # ---- Clearing ----------------------------------------------------------
    "AB": ("Clearing Document", CLEARING, SKIP),
    "DA": ("Cust. Clearing", CLEARING, SKIP),
    "DP": ("Cust DP clearingMLDL", CLEARING, SKIP),

    # ---- Transfers (move an amount already counted on its invoice) ---------
    "TP": ("Transfer Postings", TRANSFER_POSTING, SKIP),
    "TM": ("Trans Posting MUSA", TRANSFER_POSTING, SKIP),
    "KB": ("Ven. Branch Transfer", TRANSFER_POSTING, SKIP),
    "KP": ("Retention - Vendor", TRANSFER_POSTING, SKIP),
    "CV": ("Cross Co. - Vendors", TRANSFER_POSTING, SKIP),
    "CG": ("Cross Co. - GL", TRANSFER_POSTING, SKIP),
    "CC": ("Cross Co. - Customer", TRANSFER_POSTING, SKIP),
    "UD": ("IUTN/IDTN – Vendor", TRANSFER_POSTING, SKIP),
    "UC": ("IUTN/IDTN – Customer", TRANSFER_POSTING, SKIP),
    "RU": ("Intra Unit", TRANSFER_POSTING, SKIP),
    "DB": ("Cust. Branch Transfe", TRANSFER_POSTING, SKIP),
    "AI": ("Asset Transfer In", TRANSFER_POSTING, SKIP),
    "AO": ("Asset Transfer Out", TRANSFER_POSTING, SKIP),

    # ---- TDS remittance ------------------------------------------------------
    "BT": ("Tds Payments", TDS_PAYMENT, SKIP),

    # ---- Journals ------------------------------------------------------------
    "JV": ("Journal Entry", JOURNAL, SKIP),
    "JG": ("Journal Voucher", JOURNAL, VALIDATE),
    "JW": ("Journal (Ewt Only)", JOURNAL, VALIDATE),  # withholding-tax-only journal
    "XJ": ("Trlo - Jv", JOURNAL, VALIDATE),
    "YJ": ("Cfm- Journal Entries", JOURNAL, VALIDATE),

    # ---- Provisions / accruals -------------------------------------------------
    "JR": ("Provisional J.Vs", PROVISION, SKIP),
    "AM": ("Retro Amndt Accruals", PROVISION, VALIDATE),
    "XA": ("Trlo - Accr & Defrr", PROVISION, VALIDATE),
    "YP": ("Cfm - Accruals", PROVISION, VALIDATE),

    # ---- Supporting, may carry a vendor: validated ------------------------------
    "AA": ("Asset Posting", SUPPORTING, VALIDATE),
    "AN": ("Net Asset Posting", SUPPORTING, VALIDATE),
    "CU": ("Credit Advice Units", SUPPORTING, VALIDATE),
    "EE": ("Dividends", SUPPORTING, VALIDATE),
    "FC": ("Import Advise", SUPPORTING, VALIDATE),
    "LA": ("Other Loans & Adv (N", SUPPORTING, VALIDATE),
    "LU": ("Insurance On Imports", SUPPORTING, VALIDATE),
    "PI": ("P.Y Inv.Verification", SUPPORTING, VALIDATE),
    "XL": ("Trlo Doc", SUPPORTING, VALIDATE),
    "ZB": ("Sales Man Bonus(Musa", SUPPORTING, VALIDATE),
    "ZD": ("Dealer Retail(Musa)", SUPPORTING, VALIDATE),
    "ZF": (" Floor Plan (MUSA)", SUPPORTING, VALIDATE),
    "ZK": ("Warrenty Fees (Musa)", SUPPORTING, VALIDATE),
    "ZO": ("Dealer Incent liabil", SUPPORTING, VALIDATE),

    # ---- Supporting, no TDS deduction by the company: skipped when TDS-blank ----
    # G/L, material and goods movements
    "SA": ("G/L account document", SUPPORTING, SKIP),
    "ST": ("IUT - Stock Transfer", SUPPORTING, SKIP),
    "BR": ("Bank Recon. Doc.", SUPPORTING, SKIP),
    "ML": ("Material Ledger", SUPPORTING, SKIP),
    "PR": ("Price Change", SUPPORTING, SKIP),
    "QR": ("Accrual auto posting", SUPPORTING, SKIP),
    "QS": ("Cost Settlement", SUPPORTING, SKIP),
    "UG": ("IUTN/IDTN – GL", SUPPORTING, SKIP),
    "ZY": ("IFRS – GL Reclassify", SUPPORTING, SKIP),
    "ZZ": ("Sales Inv-Sd RevRec", SUPPORTING, SKIP),
    "WA": ("Goods Issue", SUPPORTING, SKIP),
    "WE": ("Goods Receipt", SUPPORTING, SKIP),
    "WI": ("Inventory Document", SUPPORTING, SKIP),
    "WL": ("Goods Issue/Delivery", SUPPORTING, SKIP),
    "WN": ("Net Goods Receipt", SUPPORTING, SKIP),
    "W2": ("GR/IR Stock posting", SUPPORTING, SKIP),
    "W3": ("Goods Receipt statem", SUPPORTING, SKIP),
    "ZG": ("Goods In Transit", SUPPORTING, SKIP),
    "ZH": ("Goods In Transit Rev", SUPPORTING, SKIP),
    # Assets
    "AF": ("Depreciation Pstngs", SUPPORTING, SKIP),
    "AP": ("Asset Post Capitaliz", SUPPORTING, SKIP),
    "AR": ("Asset Revaluation", SUPPORTING, SKIP),
    "AS": ("Asset Sale/Scrapping", SUPPORTING, SKIP),
    # CO / IFRS / valuation
    "CO": ("CO Cost Cen. Alloc", SUPPORTING, SKIP),
    "CS": ("CO Secon Cost Alloc", SUPPORTING, SKIP),
    "CH": ("Contract Settlement", SUPPORTING, SKIP),
    "IA": ("Ind. - A.S. (IFRS)", SUPPORTING, SKIP),
    "IB": ("IFRS ADJUSTMENT (MC)", SUPPORTING, SKIP),
    "IF": ("IFRS – Cost of Sales", SUPPORTING, SKIP),
    "EU": ("Euro Rounding Diff.", SUPPORTING, SKIP),
    "FX": ("Realised Exch Diff", SUPPORTING, SKIP),
    "ZR": ("Rev Rec RAR", SUPPORTING, SKIP),
    # Opening / closing balances and uploads
    "OA": ("Assets Balance uploa", SUPPORTING, SKIP),
    "OD": ("Customer line item u", SUPPORTING, SKIP),
    "OK": ("Vendor line item upl", SUPPORTING, SKIP),
    "OM": (" Material line item", SUPPORTING, SKIP),
    "OS": ("GL Balance Upload", SUPPORTING, SKIP),
    "QA": ("Opening Balance", SUPPORTING, SKIP),
    "QC": ("Closing Balance", SUPPORTING, SKIP),
    "QO": ("FY Closing Operation", SUPPORTING, SKIP),
    # Statutory (excise / customs / BOE / ISD)
    "EA": ("Excise Dept Updation", SUPPORTING, SKIP),
    "EC": ("Excise Duty Payments", SUPPORTING, SKIP),
    "ED": ("Excise Duty Debits", SUPPORTING, SKIP),
    "F7": ("Customs document", SUPPORTING, SKIP),
    "E1": ("BOE generation", SUPPORTING, SKIP),
    "E2": ("BOE Bank Presentment", SUPPORTING, SKIP),
    "E3": ("BOE Accredit", SUPPORTING, SKIP),
    "E4": ("Failed BOE", SUPPORTING, SKIP),
    "IS": ("ISD Invoice", SUPPORTING, SKIP),
    # Treasury / bank / equity
    "BI": ("Investment", SUPPORTING, SKIP),
    "TR": ("Treasury postings", SUPPORTING, SKIP),
    "YM": ("Cfm Money Market", SUPPORTING, SKIP),
    "YS": ("Cfm Securities", SUPPORTING, SKIP),
    "HX": ("Bill Discounting", SUPPORTING, SKIP),
    "HY": ("BAS Process (Disc)", SUPPORTING, SKIP),
    "EP": ("Equity / Share Premi", SUPPORTING, SKIP),
    "FI": ("Interest Income", SUPPORTING, SKIP),
    "JI": ("Vendor Early Pmt Dis", SUPPORTING, SKIP),
    # Payroll / employee (salary TDS is not vendor TDS)
    "PD": ("Payroll - Daily Rate", SUPPORTING, SKIP),
    "PM": ("Payroll - Monthly Ra", SUPPORTING, SKIP),
    "PO": ("Payroll - officers", SUPPORTING, SKIP),
    "SP": ("Salary Payments", SUPPORTING, SKIP),
    "SW": ("Salaries And Wages", SUPPORTING, SKIP),
    "SR": ("Staff Adv Rec.Salary", SUPPORTING, SKIP),
    "EX": ("Emply Expense Claims", SUPPORTING, SKIP),
    "TE": ("Travel Expenses", SUPPORTING, SKIP),
    # Customer side (sales, customer notes, dealer advances)
    "C0": ("Sell to non-Business", SUPPORTING, SKIP),
    "C1": ("IT Customer Invoice", SUPPORTING, SKIP),
    "C2": ("UE Customer Invoice", SUPPORTING, SKIP),
    "C3": ("Non-UE Customer Invo", SUPPORTING, SKIP),
    "C4": ("IT Customer Credit N", SUPPORTING, SKIP),
    "C5": ("UE Customer Credit N", SUPPORTING, SKIP),
    "C6": ("Non-UE Customer Cred", SUPPORTING, SKIP),
    "C7": ("IT Customer Debit No", SUPPORTING, SKIP),
    "C8": ("UE Customer Debit No", SUPPORTING, SKIP),
    "C9": ("Non-UE Customer Debi", SUPPORTING, SKIP),
    "D0": ("Dely. Order Fin. Co.", SUPPORTING, SKIP),
    "DC": ("Cust. Credit Non GST", SUPPORTING, SKIP),
    "DD": ("Cust. Debit Non GST", SUPPORTING, SKIP),
    "DG": ("Cust. Credit Note", SUPPORTING, SKIP),
    "DN": ("Cust. Debit Note", SUPPORTING, SKIP),
    "DR": ("Cust. Inv. Non-Sd", SUPPORTING, SKIP),
    "DT": ("Dealer Advances -GST", SUPPORTING, SKIP),
    "DU": ("Dr   Adv Units", SUPPORTING, SKIP),
    "DW": ("Warranty CustomerInv", SUPPORTING, SKIP),
    "RS": ("Sales Inv. - Sd Serv", SUPPORTING, SKIP),
    "RV": ("Sales Inv. - Sd", SUPPORTING, SKIP),
    "RW": ("VMI Billing", SUPPORTING, SKIP),
    "RX": ("Real Estate Flexi", SUPPORTING, SKIP),
    "SF": ("Cust. Inv. SFDC", SUPPORTING, SKIP),
    "ZC": ("Dealer Co Op(Musa)", SUPPORTING, SKIP),
}


def _codes(event: str) -> frozenset[str]:
    return frozenset(code for code, (_, ev, _) in DOC_TYPE_MASTER.items() if ev == event)


INVOICE_DOC_TYPES = _codes(INVOICE)
ADVANCE_DOC_TYPES = _codes(ADVANCE_PAYMENT)
PAYMENT_DOC_TYPES = _codes(PAYMENT)
CREDIT_DOC_TYPES = _codes(CREDIT_MEMO)
DEBIT_NOTE_DOC_TYPES = _codes(DEBIT_NOTE)
CLEARING_DOC_TYPES = _codes(CLEARING)
TRANSFER_POSTING_DOC_TYPES = _codes(TRANSFER_POSTING)
TDS_PAYMENT_DOC_TYPES = _codes(TDS_PAYMENT)
JOURNAL_DOC_TYPES = _codes(JOURNAL)
PROVISION_DOC_TYPES = _codes(PROVISION)
SUPPORTING_DOC_TYPES = _codes(SUPPORTING)

# Skipped only when the row carries no TDS section and no TDS amount.
NON_TDS_DEDUCTION_DOC_TYPES = frozenset(code for code, (_, _, skip) in DOC_TYPE_MASTER.items() if skip)


def normalise_doc_type(doc_type) -> str:
    return str(doc_type or "").strip().upper()


def doc_type_event(doc_type) -> str | None:
    """Ledger event for a doc type, or None when the type is not in the master."""
    entry = DOC_TYPE_MASTER.get(normalise_doc_type(doc_type))
    return entry[1] if entry else None


def doc_type_description(doc_type) -> str | None:
    entry = DOC_TYPE_MASTER.get(normalise_doc_type(doc_type))
    return entry[0].strip() if entry else None
