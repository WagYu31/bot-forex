//+------------------------------------------------------------------+
//|                                         BotForexWagyu_EA.mq5      |
//|                                         BOT FOREX WAGYU           |
//|                                         Auto-Trade via Signal API |
//+------------------------------------------------------------------+
#property copyright "BOT FOREX WAGYU"
#property link      "http://localhost:3030"
#property version   "1.00"
#property description "Expert Advisor untuk auto-trade dari sinyal BOT FOREX WAGYU"

//--- Input parameters
input string   SignalURL = "http://localhost:3030/api/signal"; // Signal API URL
input double   LotSize = 0.01;          // Ukuran Lot
input int      Slippage = 30;           // Slippage (pips)
input int      PollInterval = 5;        // Poll interval (detik)
input int      MagicNumber = 20260313;  // Magic Number

//--- Global variables
datetime lastSignalTime = 0;
string   lastDirection = "NEUTRAL";
bool     hasOpenPosition = false;
ulong    currentTicket = 0;

//+------------------------------------------------------------------+
//| Expert initialization function                                     |
//+------------------------------------------------------------------+
int OnInit()
{
    // Allow WebRequest to localhost
    Print("🚀 BOT FOREX WAGYU EA Started");
    Print("📡 Signal URL: ", SignalURL);
    Print("📊 Lot Size: ", DoubleToString(LotSize, 2));
    Print("⏱ Poll Interval: ", IntegerToString(PollInterval), " seconds");
    Print("⚠️ PENTING: Tambahkan '", SignalURL, "' ke Tools > Options > Expert Advisors > Allow WebRequest");
    
    EventSetTimer(PollInterval);
    return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                    |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
    EventKillTimer();
    Print("⏹ BOT FOREX WAGYU EA Stopped");
}

//+------------------------------------------------------------------+
//| Timer function - polls signal API                                  |
//+------------------------------------------------------------------+
void OnTimer()
{
    CheckSignal();
}

//+------------------------------------------------------------------+
//| Tick function                                                       |
//+------------------------------------------------------------------+
void OnTick()
{
    // Also check on each tick for faster response
    static datetime lastCheck = 0;
    datetime now = TimeCurrent();
    if (now - lastCheck >= PollInterval)
    {
        lastCheck = now;
        CheckSignal();
    }
}

//+------------------------------------------------------------------+
//| Check signal from API                                              |
//+------------------------------------------------------------------+
void CheckSignal()
{
    string result = "";
    string headers = "Content-Type: application/json\r\n";
    char postData[];
    char resultData[];
    string resultHeaders = "";
    
    int timeout = 5000; // 5 second timeout
    
    int res = WebRequest(
        "GET",
        SignalURL,
        headers,
        timeout,
        postData,
        resultData,
        resultHeaders
    );
    
    if (res != 200)
    {
        if (res == -1)
        {
            int error = GetLastError();
            if (error == 4014)
            {
                Print("❌ WebRequest tidak diizinkan! Tambahkan URL ke Options > Expert Advisors > Allow WebRequest");
                Print("   URL yang perlu ditambahkan: http://localhost:3030");
            }
            else
            {
                Print("⚠️ WebRequest error: ", IntegerToString(error));
            }
        }
        return;
    }
    
    result = CharArrayToString(resultData);
    
    // Parse JSON response
    string direction = ParseJsonString(result, "direction");
    double entry = ParseJsonDouble(result, "entry");
    double tp1 = ParseJsonDouble(result, "tp1");
    double sl = ParseJsonDouble(result, "sl");
    double lot = ParseJsonDouble(result, "lot");
    long timestamp = (long)ParseJsonDouble(result, "timestamp");
    bool executed = (StringFind(result, "\"executed\":true") >= 0);
    
    // Skip if already executed or same signal
    if (executed || timestamp == 0) return;
    if (timestamp <= lastSignalTime) return;
    
    // New signal detected!
    Print("📡 New signal: ", direction, " @ ", DoubleToString(entry, 2),
          " | TP: ", DoubleToString(tp1, 2), " | SL: ", DoubleToString(sl, 2));
    
    lastSignalTime = timestamp;
    
    if (lot > 0 && lot <= 1.0) LotSize == lot; // Use lot from signal if valid
    double useLot = (lot > 0 && lot <= 1.0) ? lot : LotSize;
    
    // Process signal
    if (direction == "CLOSE")
    {
        CloseAllPositions();
        ReportExecution();
    }
    else if (direction == "BUY")
    {
        CloseAllPositions(); // Close any existing before opening new
        if (OpenBuy(useLot, sl, tp1))
        {
            ReportExecution();
        }
    }
    else if (direction == "SELL")
    {
        CloseAllPositions();
        if (OpenSell(useLot, sl, tp1))
        {
            ReportExecution();
        }
    }
}

//+------------------------------------------------------------------+
//| Open BUY position                                                  |
//+------------------------------------------------------------------+
bool OpenBuy(double lot, double sl, double tp)
{
    MqlTradeRequest request = {};
    MqlTradeResult result = {};
    
    request.action = TRADE_ACTION_DEAL;
    request.symbol = _Symbol;
    request.volume = lot;
    request.type = ORDER_TYPE_BUY;
    request.price = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
    request.deviation = Slippage;
    request.magic = MagicNumber;
    request.comment = "BOT WAGYU BUY";
    request.type_filling = ORDER_FILLING_IOC;
    
    // Set SL/TP if valid
    if (sl > 0) request.sl = NormalizeDouble(sl, _Digits);
    if (tp > 0) request.tp = NormalizeDouble(tp, _Digits);
    
    if (OrderSend(request, result))
    {
        if (result.retcode == TRADE_RETCODE_DONE || result.retcode == TRADE_RETCODE_PLACED)
        {
            currentTicket = result.deal;
            hasOpenPosition = true;
            Print("✅ BUY ", DoubleToString(lot, 2), " lot @ ", 
                  DoubleToString(request.price, _Digits),
                  " | SL: ", DoubleToString(sl, _Digits),
                  " | TP: ", DoubleToString(tp, _Digits));
            return true;
        }
    }
    
    Print("❌ BUY failed: ", IntegerToString(result.retcode), " - ", result.comment);
    return false;
}

//+------------------------------------------------------------------+
//| Open SELL position                                                 |
//+------------------------------------------------------------------+
bool OpenSell(double lot, double sl, double tp)
{
    MqlTradeRequest request = {};
    MqlTradeResult result = {};
    
    request.action = TRADE_ACTION_DEAL;
    request.symbol = _Symbol;
    request.volume = lot;
    request.type = ORDER_TYPE_SELL;
    request.price = SymbolInfoDouble(_Symbol, SYMBOL_BID);
    request.deviation = Slippage;
    request.magic = MagicNumber;
    request.comment = "BOT WAGYU SELL";
    request.type_filling = ORDER_FILLING_IOC;
    
    if (sl > 0) request.sl = NormalizeDouble(sl, _Digits);
    if (tp > 0) request.tp = NormalizeDouble(tp, _Digits);
    
    if (OrderSend(request, result))
    {
        if (result.retcode == TRADE_RETCODE_DONE || result.retcode == TRADE_RETCODE_PLACED)
        {
            currentTicket = result.deal;
            hasOpenPosition = true;
            Print("✅ SELL ", DoubleToString(lot, 2), " lot @ ", 
                  DoubleToString(request.price, _Digits),
                  " | SL: ", DoubleToString(sl, _Digits),
                  " | TP: ", DoubleToString(tp, _Digits));
            return true;
        }
    }
    
    Print("❌ SELL failed: ", IntegerToString(result.retcode), " - ", result.comment);
    return false;
}

//+------------------------------------------------------------------+
//| Close all positions for this symbol                                |
//+------------------------------------------------------------------+
void CloseAllPositions()
{
    for (int i = PositionsTotal() - 1; i >= 0; i--)
    {
        ulong ticket = PositionGetTicket(i);
        if (ticket > 0)
        {
            if (PositionGetString(POSITION_SYMBOL) == _Symbol &&
                PositionGetInteger(POSITION_MAGIC) == MagicNumber)
            {
                MqlTradeRequest request = {};
                MqlTradeResult result = {};
                
                request.action = TRADE_ACTION_DEAL;
                request.position = ticket;
                request.symbol = _Symbol;
                request.volume = PositionGetDouble(POSITION_VOLUME);
                request.deviation = Slippage;
                request.type_filling = ORDER_FILLING_IOC;
                
                long posType = PositionGetInteger(POSITION_TYPE);
                if (posType == POSITION_TYPE_BUY)
                {
                    request.type = ORDER_TYPE_SELL;
                    request.price = SymbolInfoDouble(_Symbol, SYMBOL_BID);
                }
                else
                {
                    request.type = ORDER_TYPE_BUY;
                    request.price = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
                }
                
                if (OrderSend(request, result))
                {
                    Print("✅ Closed position #", IntegerToString(ticket));
                }
                else
                {
                    Print("❌ Close failed #", IntegerToString(ticket), ": ", result.comment);
                }
            }
        }
    }
    hasOpenPosition = false;
    currentTicket = 0;
}

//+------------------------------------------------------------------+
//| Report execution back to server                                    |
//+------------------------------------------------------------------+
void ReportExecution()
{
    string url = StringSubstr(SignalURL, 0, StringLen(SignalURL)) + "/executed";
    string headers = "Content-Type: application/json\r\n";
    char postData[];
    char resultData[];
    string resultHeaders = "";
    
    string body = "{\"executed\":true}";
    StringToCharArray(body, postData, 0, StringLen(body));
    
    WebRequest("POST", url, headers, 3000, postData, resultData, resultHeaders);
}

//+------------------------------------------------------------------+
//| Simple JSON string parser                                          |
//+------------------------------------------------------------------+
string ParseJsonString(string json, string key)
{
    string searchKey = "\"" + key + "\":\"";
    int pos = StringFind(json, searchKey);
    if (pos < 0) return "";
    
    int start = pos + StringLen(searchKey);
    int end = StringFind(json, "\"", start);
    if (end < 0) return "";
    
    return StringSubstr(json, start, end - start);
}

//+------------------------------------------------------------------+
//| Simple JSON number parser                                          |
//+------------------------------------------------------------------+
double ParseJsonDouble(string json, string key)
{
    string searchKey = "\"" + key + "\":";
    int pos = StringFind(json, searchKey);
    if (pos < 0) return 0;
    
    int start = pos + StringLen(searchKey);
    string numStr = "";
    
    for (int i = start; i < StringLen(json); i++)
    {
        ushort ch = StringGetCharacter(json, i);
        if ((ch >= '0' && ch <= '9') || ch == '.' || ch == '-')
        {
            numStr += ShortToString(ch);
        }
        else if (StringLen(numStr) > 0)
        {
            break;
        }
    }
    
    return StringToDouble(numStr);
}
//+------------------------------------------------------------------+
