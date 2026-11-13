# Functions

The engine computes 219 of the 524 functions Excel lists. Every one of them is below, by family, with how its answers compare to Excel's. A name that is not here answers `#NAME?`.

Each row has one of three words. `as Excel`: the function agrees with every Excel answer recorded for it (see [How the list was checked](#how-the-list-was-checked)). `differs`: it answers differently on some input, by a decided choice or a known defect, and the note says on what input. `partial`: an argument form or mode that Excel documents is not built, and the note says which.

## Choices that apply to many functions

These are decided, and each is said once. A row repeats a choice only where it is that function's daily business: the day line in the date functions, UTF-16 counting in the functions that count or cut characters, the 255 line where Excel refuses a long text, sorted data in the approximate lookups, a one-cell array in `TYPE`. The empty-text rule, the blank result and the year-less date touch nearly every function and are not repeated.

**The day line.** Day 0 is 30 December 1899 and the calendar is the real one: there is no 29 February 1900, and a negative number is a day before day 0. Dates run from 1 January 0001 to 31 December 9999, and every date function works on all of them. Excel counts 1 January 1900 as day 1 and has a 29 February 1900, so its dates in January and February 1900 are one day off from ours, and it has no dates before 1900. `DATE` reads a year from 1000 to 9999 as written, where Excel adds 1900 to any year under 1900. From 1 March 1900 on, the serials are Excel's. Example: `=YEAR(0)` is 1900 in Excel and 1899 in this engine.

**An empty text in arithmetic is 0.** An empty text, such as a cell holding `=""`, counts as 0 where a number is needed and as FALSE where a truth value is. Example: `=""+1` is `#VALUE!` in Excel and 1 in this engine, and so are `IF("",1,2)` and `NOT("")`, 2 and TRUE here.

**A blank result stays blank.** A formula whose result is blank, such as `=A1` over an empty A1, `=IF(TRUE,,1)` or a lookup that lands on an empty cell, leaves its cell blank, as Google Sheets does, where Excel stores 0. Every reader sees a blank cell: `ISBLANK` is TRUE, `COUNT` and `COUNTA` pass it over, `COUNTBLANK` counts it and `&"x"` gives `x`; arithmetic reads it as 0, as it reads any blank. A blank element of a computed array stays 0, as in Excel. Example: with `=A1` in B1, `=ISBLANK(B1)` is FALSE in Excel and TRUE in this engine.

**A date typed without a year is no number.** A text such as `"1/2"` or `"15 March"` is read as a date only by `DATEVALUE` and `TIMEVALUE`, which take the year of the recalc. Everywhere else, in arithmetic and as a date argument, it is `#VALUE!`, because reading it would make the cell depend on the clock. Example: `=VALUE("1/2")` is 2 January of this year in Excel and `#VALUE!` in this engine; `=DATEVALUE("1/2")` agrees.

**Text length is counted in UTF-16 units.** A character outside the Basic Multilingual Plane, such as an emoji, counts as 2, and `LEFT`, `MID` and their kin can cut it in half. Excel on the web counts it as 1. Example: `=LEN(UNICHAR(128512))` is 1 in Excel and 2 in this engine.

**A one-cell array is a single value.** An array of one element is not told from that element. Example: `=TYPE({"a"})` is 64 in Excel and 2 in this engine.

**No 255-character limit.** `CODE`, `UNICODE`, `REPT`, `VALUE`, `HYPERLINK`'s link, criteria and lookup keys take a text of any length up to 32,767 characters, where Excel refuses one past 255 with `#VALUE!` (recorded for `CODE`, `UNICODE`, `REPT`, `VALUE`, `HYPERLINK`, `SUMIF` and `VLOOKUP`). Example: `=CODE(REPT("a",300))` is `#VALUE!` in Excel and 97 in this engine.

**Approximate searches assume sorted data.** `MATCH` types 1 and -1, `LOOKUP`, and `VLOOKUP` and `HLOOKUP` with an approximate match halve the list, as Excel's documentation requires the list to be sorted. On a list that is not sorted Excel also reads on cell by cell and can answer another position. On sorted data, runs of equal values included, the answers agree. Example: `=MATCH(4,{6,4,2},1)` is 2 in Excel and 3 in this engine. 47 recorded rows differ this way, all on unsorted lists.

**Volatile functions are computed when the document is.** `RAND`, `RANDBETWEEN`, `NOW` and `TODAY` get a new value when the document is computed and when a cell they read changes, not after every unrelated edit. Example: type a number in an empty cell, and `=RAND()` draws again in Excel and keeps its value in this engine.

**Number display is the numfmt package.** `TEXT` and every cell's display go through numfmt: rounding and formats are Excel's, with the few known gaps listed under `TEXT`. Example: `=TEXT(0.52,"h:mm a/P")` is `12:28 P` in Excel and `12:28 a/P` in this engine.

## Math

| Function | Status | Note |
| --- | --- | --- |
| `ABS` | as Excel | |
| `ACOS` | as Excel | |
| `ACOSH` | as Excel | |
| `AGGREGATE` | partial | A `k` given as an array or a range (`AGGREGATE(14,6,D1:D8,{1,2})`) is `#VALUE!`; Excel answers one value per `k`. An error cell as `k` answers that error: over `#DIV/0!` in B4, `AGGREGATE(14,6,D1:D8,B4)` is `#DIV/0!`, Excel `#VALUE!`. The options that leave out hidden rows count them, as the engine is told of no hidden row. |
| `ASIN` | as Excel | |
| `ASINH` | as Excel | |
| `ATAN` | as Excel | |
| `ATAN2` | as Excel | |
| `ATANH` | as Excel | |
| `CEILING` | as Excel | |
| `CEILING.MATH` | as Excel | |
| `CEILING.PRECISE` | as Excel | |
| `COMBIN` | as Excel | |
| `COS` | as Excel | |
| `COSH` | as Excel | |
| `DEGREES` | as Excel | |
| `EVEN` | as Excel | |
| `EXP` | as Excel | |
| `FACT` | as Excel | |
| `FLOOR` | as Excel | |
| `FLOOR.MATH` | as Excel | |
| `FLOOR.PRECISE` | as Excel | |
| `GCD` | differs | An empty first argument is passed over: `GCD(,6)` is 6, Excel `#N/A`. One blank cell alone is 0: `GCD(Z9)`, Excel `#VALUE!`. |
| `INT` | as Excel | |
| `ISO.CEILING` | as Excel | |
| `LCM` | differs | As `GCD`: `LCM(,6)` is 6, Excel `#N/A`; `LCM(Z9)` is 0, Excel `#VALUE!`. |
| `LN` | as Excel | |
| `LOG` | differs | A base within one step of 1 can differ in the 15th digit: `LOG(100,0.9999999999999999)` is -4608853940798595, Excel -4608853940798590. |
| `LOG10` | as Excel | |
| `MOD` | as Excel | |
| `MROUND` | as Excel | |
| `MULTINOMIAL` | differs | `MULTINOMIAL(170)` is exactly 1, where Excel's own arithmetic gives 1.0000000000002. |
| `ODD` | as Excel | |
| `PI` | as Excel | |
| `POWER` | as Excel | |
| `PRODUCT` | as Excel | |
| `QUOTIENT` | as Excel | |
| `RADIANS` | as Excel | |
| `RAND` | as Excel | Volatile: see the choices. A draw is not compared with Excel's. |
| `RANDBETWEEN` | as Excel | Volatile: see the choices. A draw is not compared with Excel's. |
| `ROUND` | differs | On a true tie in the 16th digit it gives the exact answer: `ROUND(73938790243119/4,1)&""` is `18484697560779.8`, Excel `18484697560779.7`. |
| `ROUNDDOWN` | as Excel | |
| `ROUNDUP` | as Excel | |
| `SIGN` | as Excel | |
| `SIN` | as Excel | |
| `SINH` | as Excel | |
| `SQRT` | as Excel | |
| `SUBTOTAL` | partial | Codes 101 to 111 count hidden rows, as 1 to 11 do: the engine is told of no hidden row. |
| `SUM` | differs | A one-cell array constant is its element, so its text is read as a typed argument: `SUM({"TRUE"},1)` is `#VALUE!`, Excel 1. With two elements it agrees: `SUM({"TRUE","x"},1)` is 1. |
| `SUMIF` | differs | No 255-character limit on the criterion. Given a computed array where a range is needed (`SUMIF(INDEX(A1:B3,0,{1,2}),">15")`), one `#VALUE!` where Excel answers one per element. |
| `SUMIFS` | differs | No 255-character limit on a criterion. |
| `SUMPRODUCT` | differs | One blank cell as its only range is 0: `SUMPRODUCT(Z1)` and `SUMPRODUCT(Z1:Z1)`, Excel `#VALUE!`. Two blank cells agree (0). |
| `SUMSQ` | as Excel | |
| `TAN` | as Excel | |
| `TANH` | as Excel | |
| `TRUNC` | as Excel | |

## Statistical

| Function | Status | Note |
| --- | --- | --- |
| `AVEDEV` | as Excel | |
| `AVERAGE` | as Excel | |
| `AVERAGEA` | differs | A text or TRUE inside an array constant counts as 0 or 1: `AVERAGEA({3,"x",TRUE,5})` is 2.25, Excel 2.66666666666667. In cells and as typed arguments it agrees. |
| `AVERAGEIF` | differs | No 255-character limit on the criterion. |
| `AVERAGEIFS` | differs | No 255-character limit on a criterion. No Excel row is recorded for this function; it runs on `COUNTIF`'s criteria code. |
| `CORREL` | as Excel | |
| `COUNT` | as Excel | |
| `COUNTA` | differs | A blank cell in the reference array of a lifted `INDEX` or an `XLOOKUP` is not counted: `COUNTA(INDEX(C1:C4,{1;2;3;4}))` over a blank C4 is 3, Excel 4, and so is the same count over an `XLOOKUP` array, though Excel's other readers of those arrays see the blank. A blank that passes through a computed array is 0 and counted: `COUNTA(IF({1;1;1;1},C1:C4))` is 4 in both. |
| `COUNTBLANK` | differs | Given a computed array where a range is needed (`COUNTBLANK(IF({1;1},B1:B2))`), one `#VALUE!` where Excel answers one per element. |
| `COUNTIF` | differs | No 255-character limit on the criterion. |
| `COUNTIFS` | differs | No 255-character limit on a criterion. |
| `COVAR` | as Excel | |
| `COVARIANCE.P` | as Excel | |
| `COVARIANCE.S` | as Excel | |
| `DEVSQ` | as Excel | |
| `FORECAST` | as Excel | |
| `FORECAST.LINEAR` | as Excel | |
| `GEOMEAN` | as Excel | |
| `HARMEAN` | differs | `HARMEAN(1E-308,1E-308)` is 0, as the sum of the reciprocals is too large to hold; Excel stores the typed `1E-308` as 0 and answers `#NUM!`. |
| `INTERCEPT` | as Excel | |
| `LARGE` | as Excel | |
| `MAX` | as Excel | |
| `MAXA` | differs | Reads a text and TRUE inside an array constant as 0 and 1, as `AVERAGEA` does, where Excel skips them. The one recorded row on such an array, `MAXA({3,"x",TRUE,5})`, is 5 in both, since neither value changes the maximum. |
| `MAXIFS` | differs | No 255-character limit on a criterion. No Excel row is recorded for this function; it runs on `COUNTIF`'s criteria code. |
| `MEDIAN` | as Excel | |
| `MIN` | as Excel | |
| `MINA` | differs | A text or TRUE inside an array constant counts as 0 or 1: `MINA({3,"x",TRUE,5})` is 0, Excel 3. |
| `MINIFS` | differs | No 255-character limit on a criterion. No Excel row is recorded for this function; it runs on `COUNTIF`'s criteria code. |
| `MODE` | as Excel | |
| `MODE.SNGL` | as Excel | |
| `PEARSON` | as Excel | |
| `PERCENTILE` | as Excel | |
| `PERCENTILE.EXC` | as Excel | |
| `PERCENTILE.INC` | as Excel | |
| `QUARTILE` | as Excel | |
| `QUARTILE.EXC` | as Excel | |
| `QUARTILE.INC` | as Excel | |
| `RANK` | differs | An order given as a text, typed (`"1"`) or in a cell, is read as a number; Excel answers `#VALUE!`. |
| `RANK.AVG` | differs | As `RANK`: an order given as a text is read; Excel `#VALUE!`. |
| `RANK.EQ` | differs | As `RANK`: an order given as a text is read; Excel `#VALUE!`. |
| `RSQ` | as Excel | |
| `SLOPE` | as Excel | |
| `SMALL` | as Excel | |
| `STDEV` | as Excel | |
| `STDEV.P` | as Excel | |
| `STDEV.S` | as Excel | |
| `STDEVA` | differs | A text or TRUE inside an array: `STDEVA({3,"x",TRUE,5})` is 2.21735578260835, Excel 1.4142135623731. |
| `STDEVP` | as Excel | |
| `STDEVPA` | differs | A text or TRUE inside an array constant counts as 0 or 1, where Excel skips them: `STDEVPA({1,"x",TRUE,5})` is 1.92028643696715, Excel 2. |
| `STEYX` | as Excel | |
| `SUMX2MY2` | as Excel | |
| `SUMX2PY2` | as Excel | |
| `SUMXMY2` | as Excel | |
| `VAR` | as Excel | |
| `VAR.P` | as Excel | |
| `VAR.S` | as Excel | |
| `VARA` | differs | A text or TRUE inside an array constant counts as 0 or 1, where Excel skips them: `VARA({1,"x",TRUE,5})` is 4.91666666666667, Excel 8. |
| `VARP` | as Excel | |
| `VARPA` | differs | A text or TRUE inside an array constant counts as 0 or 1, where Excel skips them: `VARPA({1,"x",TRUE,5})` is 3.6875, Excel 4. |

## Text

| Function | Status | Note |
| --- | --- | --- |
| `CHAR` | as Excel | |
| `CLEAN` | as Excel | |
| `CODE` | differs | No 255-character limit. Half of an emoji is 63, by UTF-16 counting. `CODE(UNICHAR(128))` is 63, Excel 128. |
| `CONCAT` | as Excel | |
| `CONCATENATE` | differs | Past 32,767 characters the answer is `#VALUE!`, as `&` gives, where Excel cuts the text silently: `LEN(CONCATENATE(REPT("x",32767),"y"))` is `#VALUE!`, Excel 32767. |
| `DOLLAR` | as Excel | |
| `EXACT` | as Excel | |
| `FIND` | differs | Positions count UTF-16 units: in `"😀a"` the `a` is at 3, Excel 2. |
| `FIXED` | differs | On a true tie in the 16th digit it gives the exact answer: `FIXED(73938790243119/4,1)` is `18,484,697,560,779.8`, Excel `18,484,697,560,779.7`. |
| `LEFT` | differs | Counts UTF-16 units: `LEFT("😀a",1)` is half the emoji, Excel the whole one. |
| `LEN` | differs | Counts UTF-16 units: `LEN(UNICHAR(128512))` is 2, Excel 1. |
| `LOWER` | as Excel | |
| `MID` | differs | Counts UTF-16 units, as `LEFT` does. |
| `NUMBERVALUE` | differs | Keeps a 16th digit: `NUMBERVALUE("1.2345678901234567")` is 1.2345678901234567, Excel 1.23456789012345. |
| `PROPER` | differs | After a combining accent the next letter is lower case: `PROPER("e"&UNICHAR(769)&"lise")` is `Élise`, Excel `ÉLise`. |
| `REPLACE` | differs | Counts UTF-16 units, as `LEFT` does. |
| `REPT` | differs | No 255-character limit on the text repeated: `REPT(REPT("x",256),2)` is 512 characters, Excel `#VALUE!`. |
| `RIGHT` | differs | Counts UTF-16 units, as `LEFT` does. |
| `SEARCH` | differs | Positions count UTF-16 units, as `FIND` does. |
| `SUBSTITUTE` | as Excel | |
| `TEXT` | differs | The display gaps of numfmt: lower- and mixed-case `a/p` print as written (`TEXT(0.02,"hh:mm a/p")` is `00:28 a/p`, Excel `12:28 a`), and `AM/pm` takes the hour into it (`TEXT(0.52,"h:mm AM/pm")` is `12:28 A12/p12`, Excel `12:28 PM`); a negative duration is printed where Excel answers `#VALUE!`, its hours wrong past one day (`TEXT(-1.25,"[h]:mm:ss")` is `-18:00:00`); a number given as the format is printed (`TEXT(1234.567,12.5)` is 12.5, Excel 121235.5); an exact half second rounds up (`TEXT(0.5+0.5/86400,"hh:mm:ss")` is 12:00:01, Excel 12:00:00); the weekday of a time that rounds up to midnight stays on its own day (`TEXT(45000.999995,"dddd")` is Wednesday, Excel Thursday). A date format on a number past 31 December 9999 or on 1E+300 prints a year 10000 or the number, and a format or a result past 255 characters is used, where Excel answers `#VALUE!` for each. Dates follow the day line. |
| `TEXTAFTER` | differs | An error given as `if_not_found` is the answer even when the delimiter is found: `TEXTAFTER("Hello World"," ",1,0,0,1/0)` is `#DIV/0!`, Excel `World`. Of two delimiters that start at one place the one listed first wins: `TEXTAFTER("abcabc",{"b","bc"},1)` is `cabc`, Excel `abc`. |
| `TEXTBEFORE` | differs | An error given as `if_not_found` is the answer even when the delimiter is found, as in `TEXTAFTER`. |
| `TEXTJOIN` | as Excel | |
| `TRIM` | as Excel | |
| `UNICHAR` | as Excel | |
| `UNICODE` | differs | No 255-character limit. Half of an emoji, as `MID` cuts it, is that half's code: `UNICODE(MID("😀a",1,1))` is 55357, Excel 128512. |
| `UPPER` | as Excel | |
| `VALUE` | differs | No 255-character limit (`VALUE(REPT("1",300))` is a number, Excel `#VALUE!`). Not read as numbers: a percent sign in front (`VALUE("%12")`, Excel 0.12) and a two-digit year after a month name (`VALUE("June 5, 26")`, Excel 46178). |

## Date and time

Every function of this family that reads a date follows the day line, so in January and February 1900, and before 1900, its answers differ from Excel's. The notes say what else differs.

| Function | Status | Note |
| --- | --- | --- |
| `DATE` | differs | The day line: `DATE(1900,1,1)` is 2, Excel 1. A year from 1000 to 1899 is that year: `DATE(1899,12,31)` is 1, where Excel reads the year as 3799. |
| `DATEDIF` | differs | The day line. |
| `DATEVALUE` | differs | The day line: `DATEVALUE("1/1/1900")` is 2, Excel 1; `"2/29/1900"` is `#VALUE!`, Excel 60; a date before 1900 is a date, Excel `#VALUE!`. |
| `DAY` | differs | The day line: `DAY(1)` is 31, Excel 1. |
| `DAYS` | differs | The day line: `DAYS(-1,1)` is -2, Excel `#NUM!`. |
| `DAYS360` | differs | The day line. |
| `EDATE` | differs | The day line. |
| `EOMONTH` | differs | The day line. |
| `HOUR` | differs | The day line: a negative number is a time on a day before day 0, so `HOUR(-0.5)` is 12, Excel `#NUM!`. |
| `ISOWEEKNUM` | differs | The day line. |
| `MINUTE` | differs | The day line, as `HOUR`. |
| `MONTH` | differs | The day line. |
| `NETWORKDAYS` | differs | The day line. The holidays: a text among them, in a cell or in an array, is passed over, and an error cell among them is the answer; Excel answers `#VALUE!` for both, but reads a date written as text inside an array, so `NETWORKDAYS(DATE(2006,1,1),DATE(2006,2,1),{"2006/1/2","2006/1/16"})` is 23, Excel 21. |
| `NETWORKDAYS.INTL` | differs | The day line and the holidays, as `NETWORKDAYS`. An error given as the weekend is the answer, Excel `#VALUE!`. |
| `NOW` | as Excel | Volatile: see the choices. The clock is not compared with Excel's. |
| `SECOND` | differs | The day line, as `HOUR`. |
| `TIME` | as Excel | |
| `TIMEVALUE` | differs | The day line: `TIMEVALUE("1/1/1899")` is 0, Excel `#VALUE!`; `TIMEVALUE("2/29/1900")` is `#VALUE!`, Excel 0. |
| `TODAY` | as Excel | Volatile: see the choices. The clock is not compared with Excel's. |
| `WEEKDAY` | differs | The day line: `WEEKDAY(-1)` is 6, Excel `#NUM!`. |
| `WEEKNUM` | differs | The day line: 1 January 1900 is a Monday, so with weeks that start on Monday (types 2 and 11) 1900 has one week less, `WEEKNUM(366,2)` is 53, Excel 54. A negative type is `#NUM!`: `WEEKNUM(45000,-1)`, Excel 12. |
| `WORKDAY` | differs | The day line and the holidays, as `NETWORKDAYS`; with 0 days Excel does not read the holidays, ours does: `WORKDAY(45000,0,1/0)` is `#DIV/0!`, Excel 45000. |
| `WORKDAY.INTL` | differs | The day line and the holidays, as `WORKDAY`. An error given as the weekend is the answer, Excel `#NUM!`. |
| `YEAR` | differs | The day line: `YEAR(0)` is 1899, Excel 1900. |
| `YEARFRAC` | differs | The day line. With an error in two arguments Excel answers the later one's: `YEARFRAC(45000,NA(),1/0)` is `#N/A`, Excel `#DIV/0!`. |

## Logical

| Function | Status | Note |
| --- | --- | --- |
| `AND` | as Excel | |
| `CHOOSE` | as Excel | |
| `FALSE` | as Excel | |
| `IF` | differs | An array result is as wide as the condition: `COLUMNS(IF({TRUE,TRUE},1,{1,2,3}))` is 2, where Excel pads to the widest argument and answers 3. |
| `IFERROR` | differs | An array result is as wide as the value: `IFERROR({1,2},{7,8,9})` is `{1,2}`, Excel `{1,2,9}`. |
| `IFNA` | differs | As `IFERROR`: `IFNA({1,2},{7,8,9})` is `{1,2}`, Excel `{1,2,9}`. |
| `IFS` | differs | An array result can be narrower than Excel's: `ROWS(IFS({TRUE,TRUE},1,{TRUE;FALSE},2))` is 1, Excel 2. |
| `NOT` | as Excel | |
| `OR` | differs | A one-cell array constant is its element, so its text is read as a typed argument: `OR({"TRUE"})` is TRUE, Excel `#VALUE!`. With two elements it agrees: `OR({"TRUE","TRUE"})` is `#VALUE!`. |
| `SWITCH` | as Excel | |
| `TRUE` | as Excel | |
| `XOR` | as Excel | |

## Information

| Function | Status | Note |
| --- | --- | --- |
| `CELL` | partial | Built: `address`, `col`, `row`, `contents` and `type`. `filename`, `format`, `width` and the other info types are `#VALUE!`, as they need what only the host knows. An address that names a sheet lacks the file name Excel puts in front (`[Book1.xlsx]Sheet1!$A$1`). Given a computed array where a range is needed, one `#VALUE!` where Excel answers one per element. |
| `ERROR.TYPE` | as Excel | |
| `INFO` | partial | Every info type is `#VALUE!`, as Excel on the web answers; desktop Excel answers for its machine. |
| `ISBLANK` | as Excel | |
| `ISERR` | as Excel | |
| `ISERROR` | as Excel | |
| `ISEVEN` | as Excel | |
| `ISFORMULA` | differs | A range that holds more than 986,895 cells, such as a filled table of 100,000 rows by 20 columns, is `#CALC!`: the engine's bound on what one formula makes. |
| `ISLOGICAL` | as Excel | |
| `ISNA` | as Excel | |
| `ISNONTEXT` | as Excel | |
| `ISNUMBER` | as Excel | |
| `ISODD` | as Excel | |
| `ISREF` | as Excel | |
| `ISTEXT` | as Excel | |
| `N` | as Excel | |
| `NA` | as Excel | |
| `SHEET` | partial | A sheet name given as text (`SHEET("Sales")`) is `#N/A`, and a 3-D reference (`SHEET(Sheet1:Sheet3!A1)`) is not computed. |
| `SHEETS` | partial | A 3-D reference (`SHEETS(Sheet1:Sheet3!A1)`) is not computed. |
| `T` | as Excel | |
| `TYPE` | differs | A one-cell array is a single value: `TYPE({"a"})` is 2, Excel 64. |

## Lookup and reference

| Function | Status | Note |
| --- | --- | --- |
| `ADDRESS` | differs | A sheet name with square brackets is quoted: `ADDRESS(2,3,1,TRUE,"[b]x")` is `'[b]x'!$C$2`, Excel `[b]x!$C$2`. |
| `AREAS` | differs | A union across two sheets is counted: `AREAS((Sheet2!A1,A1))` is 2, Excel `#VALUE!`. |
| `COLUMN` | as Excel | |
| `COLUMNS` | as Excel | |
| `FORMULATEXT` | differs | A range that holds more than 986,895 cells is `#CALC!`, as for `ISFORMULA`. |
| `HLOOKUP` | differs | Sorted data, for an approximate match. A row index given as a range or an array is read where Excel answers `#VALUE!` or `#REF!`, and a cell that holds a text or an error there answers `#VALUE!` or that error, where Excel answers `#REF!`. No 255-character limit on the key. |
| `HYPERLINK` | differs | A link of any length a text can have: `HYPERLINK(REPT("a",300),"f")` is `f`, where Excel answers `#VALUE!` past 255 characters. |
| `INDEX` | as Excel | |
| `INDIRECT` | partial | R1C1 text that names a whole row or column (`INDIRECT("R1",FALSE)`, `"C1"`, `"R[1]"`, `"R:R"`) is `#REF!`; Excel answers the row or column. |
| `LOOKUP` | differs | Sorted data. A result range shorter than, or shaped unlike, the lookup range is `#N/A` where Excel reads the cells past its end (`LOOKUP(20,A1:A5,B1)`). Over an array of references (`LOOKUP(2,{1,2},OFFSET(A1,{0,1},0,2))`) it answers one value where Excel answers one per reference. |
| `MATCH` | differs | Sorted data, for types 1 and -1: `MATCH("a",{1,"a",2,"a",3,"a"},1)` is 6, Excel 4. A match type given as a range is read, and a cell that holds a text or an error there answers `#VALUE!` or that error, where Excel answers `#REF!`. An exact match folds ß as ss: over `ss` and `ß`, `MATCH("ß",A1:A2,0)` is 1, Excel 2 (criteria agree: `COUNTIF` folds as Excel does). Numbers compare on 15 digits: `MATCH(1E+15+1,{1E+15,1000000000000001},0)` is 1, Excel `#N/A`, and an exact match finds what `=` calls equal: over `=0.1+0.2` in D1, `MATCH(0.3,D1,0)` is 1, Excel `#N/A`. A one-cell array is its value: `MATCH(2,2,0)` is 1 and `MATCH(2,{#DIV/0!},0)` `#DIV/0!`, Excel `#N/A` for both. No 255-character limit on the key. |
| `OFFSET` | as Excel | |
| `ROW` | differs | Given a computed array where a reference is needed (`ROW(INDEX(A1:B3,{1,2},1))`), one `#VALUE!` where Excel answers one per element. |
| `ROWS` | as Excel | |
| `VLOOKUP` | differs | Sorted data, for an approximate match. A column index given as a range or an array is read where Excel answers `#VALUE!` or `#REF!`, and a cell that holds a text or an error there answers `#VALUE!` or that error, where Excel answers `#REF!`. No 255-character limit on the key: `VLOOKUP(REPT("a",256),A1:B2,2,FALSE)` is `#N/A`, Excel `#VALUE!`. A one-cell array is its value: `VLOOKUP(5,5,1,FALSE)` is 5, Excel `#N/A`. |
| `XLOOKUP` | partial | Match mode 3, regular expressions, is not built: `XLOOKUP(25,E1:E4,D1:D4,"nf",3)` is `#VALUE!`. An `if_not_found` given as an array is paired element by element with the keys, where Excel uses its first element. |
| `XMATCH` | partial | Match mode 3, regular expressions, is not built: `XMATCH(4,C1:C3,3)` is `#VALUE!`. |

## Not built

305 of Excel's functions are not built, and each answers `#NAME?`. Most of them are whole families: the dynamic-array functions (`FILTER`, `SORT`, `UNIQUE`, `SEQUENCE`, `TRANSPOSE` and their kin), `LET` and `LAMBDA` with their helpers, and the financial, engineering, distribution, database and cube functions. The rest are single functions of the built families, such as `ROMAN`, `TEXTSPLIT`, `LENB` and the other byte forms, `FREQUENCY`, `PERCENTRANK`, `MMULT`, the regular-expression functions and the web functions. Excel's full list is `EXCEL_2007_FUNCTIONS` and `EXCEL_FUTURE_FUNCTIONS` in `src/functions/excel-names.ts`.

## How the list was checked

`as Excel` means the function agrees with every Excel answer recorded for it, not that it was proven equal. The answers were recorded in Excel on the web, English (US), and every one was computed again on this build: 17,654 rows from the family batches and the later batches (math 2,414, statistical 3,152, text 3,046, date and time 3,285, logical 1,051, information 1,530, lookup and reference 2,865, operators alone 311), and about 200 more for `CEILING.PRECISE`, `FLOOR.PRECISE`, `ISO.CEILING`, number formats and the open checks. A row counts toward the function it probes, which is mostly the outermost one: `COLUMNS(IF({TRUE,TRUE},1,{1,2,3}))` counts for `IF`, and a row that probes an operator, such as `SUM((A1:A2,C1:C2) A1:C1)` for the intersection, for no function ([FORMULA.md § Known differences](../../docs/FORMULA.md#known-differences-from-excel)). Rows whose recorded value could not be read as a value, such as a text cut at 40 characters in the record, were judged by hand. Where a source and a run disagreed, the run on this build decided. `src/test/functions/functions-list.test.ts` keeps the names of this list equal to the functions the engine computes.
