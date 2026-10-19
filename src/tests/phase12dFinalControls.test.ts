import {describe,expect,it} from 'vitest';
import type {ParserWorkbook,WorkbookRow} from '../models/workbook';
import {parseTrialBalance} from '../parsers/tbDetection';

/** Public-safe, synthetic CCH ending controls; no client source data. */
const row=(marker:string,values:Record<number,string|number|null>={}):WorkbookRow=>({
  sourceRowNumber:0,
  cells:Array.from({length:14},(_,i)=>({value:i===0?marker:values[i]??null})),
});
const source=():ParserWorkbook=>{
  const rows=[
    row('RPT_HEADERCLIENT',{4:'Client:',5:'Synthetic Example'}),
    row('Col_Metadata_row_2',{4:'NameCol',5:'DescCol'}),
    row('Col_Header_1',{4:'Account',5:'Description',6:'1st PP-FINAL',8:'UNADJ',11:'AJE',13:'FINAL'}),
    row('Col_Header_2',{6:'12/31/2024',8:'12/31/2025',13:'12/31/2025'}),
    row('T_First'),row('G_{1}',{4:'Group : [ROOT]',5:'Trial Balance'}),
    row('SG_{10}',{4:'Subgroup : [10000]',5:'Synthetic Leadcode'}),
    row('AD_{1}',{4:'100100',5:'Synthetic Account',6:0,8:0,11:0,13:0}),
    row('SG_{10}_T',{4:'Subtotal [10000]',6:0,8:0,13:0}),row('SG_{10}_T_B'),
    row('G_{1}_T',{4:'Total [ROOT]'}),row('NetIncomeLoss_B'),
    row('NetIncomeLoss',{5:'NET (INCOME) LOSS',6:0,8:0,13:0}),
    row('SumAccountGroups_B'),
    row('SumAccountGroups',{5:'Sum of Account Groups',6:0,8:0,11:0,13:0}),
  ].map((r,i)=>({...r,sourceRowNumber:i+1}));
  return {metadata:{fileName:'synthetic-cch.xlsx',sizeBytes:0,extension:'xlsx',sheetNames:['Synthetic CCH'],sheetCount:1},sheets:[{name:'Synthetic CCH',rows}]};
};
const change=(book:ParserWorkbook,fn:(row:WorkbookRow)=>WorkbookRow|readonly WorkbookRow[]):ParserWorkbook=>({
  ...book,sheets:book.sheets.map(sheet=>({...sheet,rows:sheet.rows.flatMap(fn).map((r,i)=>({...r,sourceRowNumber:i+1}))})),
});
const code=(book:ParserWorkbook)=>parseTrialBalance(book).errors.map(error=>error.code);

describe('published CCH final report controls',()=>{
  it('accepts the valid final pair without changing posting accounts or balances',()=>{
    const result=parseTrialBalance(source());
    expect(result.errors).toEqual([]);
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]).toMatchObject({accountNumber:'100100',leadcode:'10000',unadjustedBalance:0});
    expect(result.diagnostics.skippedRows).toMatchObject({postingAccount:1,finalControlSpacer:1,finalControlTotal:1});
  });
  it('blocks absent, reversed, and misplaced final controls',()=>{
    const original=source();
    for(const missing of ['SumAccountGroups_B','SumAccountGroups'])
      expect(code(change(original,r=>r.cells[0]?.value===missing?[]:r))).toContain('CCH_FINAL_CONTROL_SEQUENCE');
    expect(code(change(original,r=>r.cells[0]?.value==='SumAccountGroups_B'?row('SumAccountGroups',{5:'Sum of Account Groups',6:0,8:0,11:0,13:0}):r.cells[0]?.value==='SumAccountGroups'?row('SumAccountGroups_B'):r))).toContain('CCH_FINAL_CONTROL_SEQUENCE');
    expect(code(change(original,r=>r.cells[0]?.value==='AD_{1}'?[row('SumAccountGroups_B'),r]:r))).toContain('CCH_FINAL_CONTROL_SEQUENCE');
  });
  it('blocks unexpected financial information, formulas, and unknown rows',()=>{
    const original=source();
    expect(code(change(original,r=>r.cells[0]?.value==='SumAccountGroups'?{...r,cells:r.cells.map((c,i)=>i===8?{value:1}:c)}:r))).toContain('CCH_FINAL_CONTROL_DATA');
    expect(code(change(original,r=>r.cells[0]?.value==='SumAccountGroups'?{...r,cells:r.cells.map((c,i)=>i===8?{value:0,formula:'SUM(I1:I9)'}:c)}:r))).toContain('CCH_FINAL_CONTROL_DATA');
    expect(code(change(original,r=>r.cells[0]?.value==='SumAccountGroups_B'?[row('UnknownReportRow'),r]:r))).toContain('CCH_UNKNOWN_ROW');
  });
});
