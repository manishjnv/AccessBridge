/**
 * AccessBridge — Indian Language Voice Command Registry
 *
 * Unified native-script voice commands for 10 Indian languages, dispatched via
 * the Web Speech API. Action names match the English dispatcher in
 * content/index.ts so that a Tamil, Telugu, Bengali, Urdu, etc. transcript
 * routes through the same switch as "scroll up" / "go back" / etc.
 *
 * Languages: Hindi, Tamil, Telugu, Kannada, Bengali, Marathi, Gujarati,
 * Malayalam, Punjabi, Urdu.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IndicLangCode =
  | 'hi-IN'
  | 'ta-IN'
  | 'te-IN'
  | 'kn-IN'
  | 'bn-IN'
  | 'mr-IN'
  | 'gu-IN'
  | 'ml-IN'
  | 'pa-IN'
  | 'ur-IN';

export interface IndicCommandMapping {
  /** Native-script phrase(s) that trigger this command. */
  phrases: string[];
  /** English action identifier (matches dispatcher in content/index.ts). */
  action: string;
  /** Whether the command accepts trailing arguments. */
  hasArgs: boolean;
}

export interface MatchResult {
  action: string;
  args: string;
}

export interface IndicLanguageInfo {
  code: IndicLangCode;
  label: string;
  nativeName: string;
  speakersMillions: number;
  flag: string;
}

// ---------------------------------------------------------------------------
// Language metadata (speaker counts ~2023 estimates, first + second language)
// ---------------------------------------------------------------------------

export const SUPPORTED_INDIC_LANGUAGES: readonly IndicLanguageInfo[] = [
  { code: 'hi-IN', label: 'Hindi', nativeName: 'हिन्दी', speakersMillions: 602, flag: 'HI' },
  { code: 'bn-IN', label: 'Bengali', nativeName: 'বাংলা', speakersMillions: 273, flag: 'BN' },
  { code: 'ur-IN', label: 'Urdu', nativeName: 'اردو', speakersMillions: 232, flag: 'UR' },
  { code: 'pa-IN', label: 'Punjabi', nativeName: 'ਪੰਜਾਬੀ', speakersMillions: 113, flag: 'PA' },
  { code: 'mr-IN', label: 'Marathi', nativeName: 'मराठी', speakersMillions: 99, flag: 'MR' },
  { code: 'te-IN', label: 'Telugu', nativeName: 'తెలుగు', speakersMillions: 96, flag: 'TE' },
  { code: 'ta-IN', label: 'Tamil', nativeName: 'தமிழ்', speakersMillions: 86, flag: 'TA' },
  { code: 'gu-IN', label: 'Gujarati', nativeName: 'ગુજરાતી', speakersMillions: 62, flag: 'GU' },
  { code: 'kn-IN', label: 'Kannada', nativeName: 'ಕನ್ನಡ', speakersMillions: 59, flag: 'KN' },
  { code: 'ml-IN', label: 'Malayalam', nativeName: 'മലയാളം', speakersMillions: 38, flag: 'ML' },
] as const;

// ---------------------------------------------------------------------------
// Hindi (hi-IN) — matches existing hindi-commands.ts mappings
// ---------------------------------------------------------------------------

const HI_COMMANDS: IndicCommandMapping[] = [
  { phrases: ['ऊपर स्क्रॉल', 'ऊपर जाओ', 'ऊपर'], action: 'scroll-up', hasArgs: false },
  { phrases: ['नीचे स्क्रॉल', 'नीचे जाओ', 'नीचे'], action: 'scroll-down', hasArgs: false },
  { phrases: ['शुरू में जाओ', 'टॉप पर जाओ', 'सबसे ऊपर'], action: 'go-to-top', hasArgs: false },
  { phrases: ['अंत में जाओ', 'नीचे तक जाओ', 'सबसे नीचे'], action: 'go-to-bottom', hasArgs: false },
  { phrases: ['पीछे जाओ', 'वापस जाओ'], action: 'go-back', hasArgs: false },
  { phrases: ['आगे जाओ', 'आगे'], action: 'go-forward', hasArgs: false },
  { phrases: ['पेज लोड करो', 'रीलोड', 'दोबारा लोड'], action: 'reload', hasArgs: false },
  { phrases: ['बड़ा करो', 'ज़ूम इन'], action: 'zoom-in', hasArgs: false },
  { phrases: ['छोटा करो', 'ज़ूम आउट'], action: 'zoom-out', hasArgs: false },
  { phrases: ['अगला टैब', 'नेक्स्ट टैब'], action: 'next-tab', hasArgs: false },
  { phrases: ['पिछला टैब', 'प्रीवियस टैब'], action: 'prev-tab', hasArgs: false },
  { phrases: ['टैब बंद करो', 'ये बंद करो'], action: 'close-tab', hasArgs: false },
  { phrases: ['नया टैब', 'नया पेज'], action: 'new-tab', hasArgs: false },
  { phrases: ['फोकस मोड', 'ध्यान मोड'], action: 'focus-mode', hasArgs: false },
  { phrases: ['पढ़ने का मोड', 'रीडिंग मोड'], action: 'reading-mode', hasArgs: false },
  { phrases: ['पेज पढ़ो', 'पढ़ कर सुनाओ', 'पढ़ो'], action: 'read-page', hasArgs: false },
  { phrases: ['सारांश दो', 'समरी दिखाओ', 'सारांश'], action: 'summarize', hasArgs: false },
  { phrases: ['सरल करो', 'आसान भाषा', 'सिम्प्लीफाई'], action: 'simplify', hasArgs: false },
  { phrases: ['ईमेल सारांश', 'ईमेल की समरी'], action: 'summarize-email', hasArgs: false },
  { phrases: ['क्लिक करो', 'दबाओ'], action: 'click', hasArgs: true },
  { phrases: ['लिखो', 'टाइप करो'], action: 'type', hasArgs: true },
  { phrases: ['खोजो', 'ढूंढो', 'ढूँढो'], action: 'find', hasArgs: true },
  { phrases: ['सुनना बंद करो', 'बंद करो', 'रुको'], action: 'stop-listening', hasArgs: false },
  { phrases: ['मदद', 'हेल्प', 'सहायता'], action: 'help', hasArgs: false },
];

// ---------------------------------------------------------------------------
// Marathi (mr-IN) — Devanagari script, distinct vocabulary
// ---------------------------------------------------------------------------

const MR_COMMANDS: IndicCommandMapping[] = [
  { phrases: ['वर स्क्रोल', 'वर जा', 'वर'], action: 'scroll-up', hasArgs: false },
  { phrases: ['खाली स्क्रोल', 'खाली जा', 'खाली'], action: 'scroll-down', hasArgs: false },
  { phrases: ['सुरुवातीला जा', 'वरपर्यंत जा'], action: 'go-to-top', hasArgs: false },
  { phrases: ['शेवटी जा', 'खालपर्यंत जा'], action: 'go-to-bottom', hasArgs: false },
  { phrases: ['मागे जा', 'परत जा'], action: 'go-back', hasArgs: false },
  { phrases: ['पुढे जा', 'पुढे'], action: 'go-forward', hasArgs: false },
  { phrases: ['पुन्हा लोड', 'रीलोड'], action: 'reload', hasArgs: false },
  { phrases: ['मोठे करा', 'झूम इन'], action: 'zoom-in', hasArgs: false },
  { phrases: ['लहान करा', 'झूम आऊट'], action: 'zoom-out', hasArgs: false },
  { phrases: ['पुढील टॅब', 'नेक्स्ट टॅब'], action: 'next-tab', hasArgs: false },
  { phrases: ['मागील टॅब', 'प्रीव्हियस टॅब'], action: 'prev-tab', hasArgs: false },
  { phrases: ['टॅब बंद करा'], action: 'close-tab', hasArgs: false },
  { phrases: ['नवीन टॅब'], action: 'new-tab', hasArgs: false },
  { phrases: ['फोकस मोड', 'लक्ष मोड'], action: 'focus-mode', hasArgs: false },
  { phrases: ['वाचन मोड', 'रीडिंग मोड'], action: 'reading-mode', hasArgs: false },
  { phrases: ['पेज वाचा', 'वाचून दाखवा'], action: 'read-page', hasArgs: false },
  { phrases: ['सारांश द्या', 'सारांश'], action: 'summarize', hasArgs: false },
  { phrases: ['सोपे करा', 'सरळ करा'], action: 'simplify', hasArgs: false },
  { phrases: ['ईमेल सारांश'], action: 'summarize-email', hasArgs: false },
  { phrases: ['क्लिक करा', 'दाबा'], action: 'click', hasArgs: true },
  { phrases: ['टाइप करा', 'लिहा'], action: 'type', hasArgs: true },
  { phrases: ['शोधा'], action: 'find', hasArgs: true },
  { phrases: ['ऐकणे थांबवा', 'थांबा'], action: 'stop-listening', hasArgs: false },
  { phrases: ['मदत', 'हेल्प'], action: 'help', hasArgs: false },
];

// ---------------------------------------------------------------------------
// Tamil (ta-IN)
// ---------------------------------------------------------------------------

const TA_COMMANDS: IndicCommandMapping[] = [
  { phrases: ['மேலே ஸ்க்ரோல்', 'மேலே போ', 'மேலே'], action: 'scroll-up', hasArgs: false },
  { phrases: ['கீழே ஸ்க்ரோல்', 'கீழே போ', 'கீழே'], action: 'scroll-down', hasArgs: false },
  { phrases: ['ஆரம்பத்திற்கு போ', 'மேல் பக்கம்'], action: 'go-to-top', hasArgs: false },
  { phrases: ['முடிவிற்கு போ', 'கடைசிக்கு போ'], action: 'go-to-bottom', hasArgs: false },
  { phrases: ['பின்னே போ', 'திரும்பி போ'], action: 'go-back', hasArgs: false },
  { phrases: ['முன்னே போ', 'முன்னே'], action: 'go-forward', hasArgs: false },
  { phrases: ['மீண்டும் ஏற்று', 'ரீலோட்'], action: 'reload', hasArgs: false },
  { phrases: ['பெரிதாக்கு', 'ஜூம் இன்'], action: 'zoom-in', hasArgs: false },
  { phrases: ['சிறிதாக்கு', 'ஜூம் அவுட்'], action: 'zoom-out', hasArgs: false },
  { phrases: ['அடுத்த டேப்', 'அடுத்த தாவல்'], action: 'next-tab', hasArgs: false },
  { phrases: ['முந்தைய டேப்', 'முந்தைய தாவல்'], action: 'prev-tab', hasArgs: false },
  { phrases: ['டேப் மூடு', 'தாவல் மூடு'], action: 'close-tab', hasArgs: false },
  { phrases: ['புதிய டேப்', 'புதிய தாவல்'], action: 'new-tab', hasArgs: false },
  { phrases: ['கவன முறை', 'ஃபோகஸ் மோட்'], action: 'focus-mode', hasArgs: false },
  { phrases: ['வாசிப்பு முறை', 'ரீடிங் மோட்'], action: 'reading-mode', hasArgs: false },
  { phrases: ['பக்கத்தை படி', 'படித்து காட்டு'], action: 'read-page', hasArgs: false },
  { phrases: ['சுருக்கம் கொடு', 'சுருக்கம்'], action: 'summarize', hasArgs: false },
  { phrases: ['எளிதாக்கு', 'சுலபமாக்கு'], action: 'simplify', hasArgs: false },
  { phrases: ['மின்னஞ்சல் சுருக்கம்'], action: 'summarize-email', hasArgs: false },
  { phrases: ['கிளிக் செய்', 'அழுத்து'], action: 'click', hasArgs: true },
  { phrases: ['தட்டச்சு செய்', 'எழுது'], action: 'type', hasArgs: true },
  { phrases: ['தேடு', 'கண்டுபிடி'], action: 'find', hasArgs: true },
  { phrases: ['கேட்பதை நிறுத்து', 'நிறுத்து'], action: 'stop-listening', hasArgs: false },
  { phrases: ['உதவி', 'ஹெல்ப்'], action: 'help', hasArgs: false },
];

// ---------------------------------------------------------------------------
// Telugu (te-IN)
// ---------------------------------------------------------------------------

const TE_COMMANDS: IndicCommandMapping[] = [
  { phrases: ['పైకి స్క్రోల్', 'పైకి వెళ్ళు', 'పైకి'], action: 'scroll-up', hasArgs: false },
  { phrases: ['క్రిందకి స్క్రోల్', 'క్రిందకి వెళ్ళు', 'క్రిందకి'], action: 'scroll-down', hasArgs: false },
  { phrases: ['మొదటికి వెళ్ళు', 'పై భాగానికి'], action: 'go-to-top', hasArgs: false },
  { phrases: ['చివరికి వెళ్ళు', 'చివరకి'], action: 'go-to-bottom', hasArgs: false },
  { phrases: ['వెనక్కి వెళ్ళు', 'వెనక్కి'], action: 'go-back', hasArgs: false },
  { phrases: ['ముందుకి వెళ్ళు', 'ముందుకి'], action: 'go-forward', hasArgs: false },
  { phrases: ['మళ్ళీ లోడ్', 'రీలోడ్'], action: 'reload', hasArgs: false },
  { phrases: ['పెద్దది చేయి', 'జూమ్ ఇన్'], action: 'zoom-in', hasArgs: false },
  { phrases: ['చిన్నది చేయి', 'జూమ్ అవుట్'], action: 'zoom-out', hasArgs: false },
  { phrases: ['తర్వాత ట్యాబ్'], action: 'next-tab', hasArgs: false },
  { phrases: ['ముందు ట్యాబ్'], action: 'prev-tab', hasArgs: false },
  { phrases: ['ట్యాబ్ మూసివేయి'], action: 'close-tab', hasArgs: false },
  { phrases: ['కొత్త ట్యాబ్'], action: 'new-tab', hasArgs: false },
  { phrases: ['ఫోకస్ మోడ్', 'ధ్యాస మోడ్'], action: 'focus-mode', hasArgs: false },
  { phrases: ['చదవడం మోడ్', 'రీడింగ్ మోడ్'], action: 'reading-mode', hasArgs: false },
  { phrases: ['పేజీ చదువు', 'చదివి వినిపించు'], action: 'read-page', hasArgs: false },
  { phrases: ['సారాంశం చెప్పు', 'సారాంశం'], action: 'summarize', hasArgs: false },
  { phrases: ['సులభం చేయి', 'సులువుగా'], action: 'simplify', hasArgs: false },
  { phrases: ['ఇమెయిల్ సారాంశం'], action: 'summarize-email', hasArgs: false },
  { phrases: ['క్లిక్ చేయి', 'నొక్కు'], action: 'click', hasArgs: true },
  { phrases: ['టైప్ చేయి', 'రాయి'], action: 'type', hasArgs: true },
  { phrases: ['వెతుకు', 'కనుగొను'], action: 'find', hasArgs: true },
  { phrases: ['వినడం ఆపు', 'ఆపు'], action: 'stop-listening', hasArgs: false },
  { phrases: ['సహాయం', 'హెల్ప్'], action: 'help', hasArgs: false },
];

// ---------------------------------------------------------------------------
// Kannada (kn-IN)
// ---------------------------------------------------------------------------

const KN_COMMANDS: IndicCommandMapping[] = [
  { phrases: ['ಮೇಲೆ ಸ್ಕ್ರೋಲ್', 'ಮೇಲೆ ಹೋಗು', 'ಮೇಲೆ'], action: 'scroll-up', hasArgs: false },
  { phrases: ['ಕೆಳಗೆ ಸ್ಕ್ರೋಲ್', 'ಕೆಳಗೆ ಹೋಗು', 'ಕೆಳಗೆ'], action: 'scroll-down', hasArgs: false },
  { phrases: ['ಮೊದಲಿಗೆ ಹೋಗು', 'ಮೇಲ್ಭಾಗಕ್ಕೆ'], action: 'go-to-top', hasArgs: false },
  { phrases: ['ಕೊನೆಗೆ ಹೋಗು', 'ಕೆಳಭಾಗಕ್ಕೆ'], action: 'go-to-bottom', hasArgs: false },
  { phrases: ['ಹಿಂದೆ ಹೋಗು', 'ವಾಪಸ್ ಹೋಗು'], action: 'go-back', hasArgs: false },
  { phrases: ['ಮುಂದೆ ಹೋಗು', 'ಮುಂದೆ'], action: 'go-forward', hasArgs: false },
  { phrases: ['ಮತ್ತೆ ಲೋಡ್', 'ರೀಲೋಡ್'], action: 'reload', hasArgs: false },
  { phrases: ['ದೊಡ್ಡದು ಮಾಡು', 'ಜೂಮ್ ಇನ್'], action: 'zoom-in', hasArgs: false },
  { phrases: ['ಚಿಕ್ಕದು ಮಾಡು', 'ಜೂಮ್ ಔಟ್'], action: 'zoom-out', hasArgs: false },
  { phrases: ['ಮುಂದಿನ ಟ್ಯಾಬ್'], action: 'next-tab', hasArgs: false },
  { phrases: ['ಹಿಂದಿನ ಟ್ಯಾಬ್'], action: 'prev-tab', hasArgs: false },
  { phrases: ['ಟ್ಯಾಬ್ ಮುಚ್ಚು'], action: 'close-tab', hasArgs: false },
  { phrases: ['ಹೊಸ ಟ್ಯಾಬ್'], action: 'new-tab', hasArgs: false },
  { phrases: ['ಫೋಕಸ್ ಮೋಡ್', 'ಗಮನ ಮೋಡ್'], action: 'focus-mode', hasArgs: false },
  { phrases: ['ಓದುವ ಮೋಡ್', 'ರೀಡಿಂಗ್ ಮೋಡ್'], action: 'reading-mode', hasArgs: false },
  { phrases: ['ಪುಟ ಓದು', 'ಓದಿ ಕೇಳಿಸು'], action: 'read-page', hasArgs: false },
  { phrases: ['ಸಾರಾಂಶ ಕೊಡು', 'ಸಾರಾಂಶ'], action: 'summarize', hasArgs: false },
  { phrases: ['ಸರಳಗೊಳಿಸು', 'ಸುಲಭಗೊಳಿಸು'], action: 'simplify', hasArgs: false },
  { phrases: ['ಇಮೇಲ್ ಸಾರಾಂಶ'], action: 'summarize-email', hasArgs: false },
  { phrases: ['ಕ್ಲಿಕ್ ಮಾಡು', 'ಒತ್ತು'], action: 'click', hasArgs: true },
  { phrases: ['ಟೈಪ್ ಮಾಡು', 'ಬರೆ'], action: 'type', hasArgs: true },
  { phrases: ['ಹುಡುಕು', 'ಕಂಡುಹಿಡಿ'], action: 'find', hasArgs: true },
  { phrases: ['ಕೇಳುವುದನ್ನು ನಿಲ್ಲಿಸು', 'ನಿಲ್ಲಿಸು'], action: 'stop-listening', hasArgs: false },
  { phrases: ['ಸಹಾಯ', 'ಹೆಲ್ಪ್'], action: 'help', hasArgs: false },
];

// ---------------------------------------------------------------------------
// Bengali (bn-IN)
// ---------------------------------------------------------------------------

const BN_COMMANDS: IndicCommandMapping[] = [
  { phrases: ['উপরে স্ক্রোল', 'উপরে যাও', 'উপরে'], action: 'scroll-up', hasArgs: false },
  { phrases: ['নিচে স্ক্রোল', 'নিচে যাও', 'নিচে'], action: 'scroll-down', hasArgs: false },
  { phrases: ['শুরুতে যাও', 'উপরের দিকে'], action: 'go-to-top', hasArgs: false },
  { phrases: ['শেষে যাও', 'নিচের দিকে'], action: 'go-to-bottom', hasArgs: false },
  { phrases: ['পিছনে যাও', 'ফিরে যাও'], action: 'go-back', hasArgs: false },
  { phrases: ['সামনে যাও', 'সামনে'], action: 'go-forward', hasArgs: false },
  { phrases: ['আবার লোড', 'রিলোড'], action: 'reload', hasArgs: false },
  { phrases: ['বড় করো', 'জুম ইন'], action: 'zoom-in', hasArgs: false },
  { phrases: ['ছোট করো', 'জুম আউট'], action: 'zoom-out', hasArgs: false },
  { phrases: ['পরের ট্যাব'], action: 'next-tab', hasArgs: false },
  { phrases: ['আগের ট্যাব'], action: 'prev-tab', hasArgs: false },
  { phrases: ['ট্যাব বন্ধ করো'], action: 'close-tab', hasArgs: false },
  { phrases: ['নতুন ট্যাব'], action: 'new-tab', hasArgs: false },
  { phrases: ['ফোকাস মোড', 'মনোযোগ মোড'], action: 'focus-mode', hasArgs: false },
  { phrases: ['পড়ার মোড', 'রিডিং মোড'], action: 'reading-mode', hasArgs: false },
  { phrases: ['পৃষ্ঠা পড়ো', 'পড়ে শোনাও'], action: 'read-page', hasArgs: false },
  { phrases: ['সারসংক্ষেপ দাও', 'সারসংক্ষেপ'], action: 'summarize', hasArgs: false },
  { phrases: ['সহজ করো', 'সরল করো'], action: 'simplify', hasArgs: false },
  { phrases: ['ইমেইল সারসংক্ষেপ'], action: 'summarize-email', hasArgs: false },
  { phrases: ['ক্লিক করো', 'চাপো'], action: 'click', hasArgs: true },
  { phrases: ['টাইপ করো', 'লেখো'], action: 'type', hasArgs: true },
  { phrases: ['খোঁজো', 'অনুসন্ধান'], action: 'find', hasArgs: true },
  { phrases: ['শোনা বন্ধ করো', 'বন্ধ করো'], action: 'stop-listening', hasArgs: false },
  { phrases: ['সাহায্য', 'হেল্প'], action: 'help', hasArgs: false },
];

// ---------------------------------------------------------------------------
// Gujarati (gu-IN)
// ---------------------------------------------------------------------------

const GU_COMMANDS: IndicCommandMapping[] = [
  { phrases: ['ઉપર સ્ક્રોલ', 'ઉપર જાઓ', 'ઉપર'], action: 'scroll-up', hasArgs: false },
  { phrases: ['નીચે સ્ક્રોલ', 'નીચે જાઓ', 'નીચે'], action: 'scroll-down', hasArgs: false },
  { phrases: ['શરૂઆતમાં જાઓ', 'ઉપરના ભાગે'], action: 'go-to-top', hasArgs: false },
  { phrases: ['અંતમાં જાઓ', 'નીચેના ભાગે'], action: 'go-to-bottom', hasArgs: false },
  { phrases: ['પાછળ જાઓ', 'પાછા જાઓ'], action: 'go-back', hasArgs: false },
  { phrases: ['આગળ જાઓ', 'આગળ'], action: 'go-forward', hasArgs: false },
  { phrases: ['ફરી લોડ', 'રીલોડ'], action: 'reload', hasArgs: false },
  { phrases: ['મોટું કરો', 'ઝૂમ ઇન'], action: 'zoom-in', hasArgs: false },
  { phrases: ['નાનું કરો', 'ઝૂમ આઉટ'], action: 'zoom-out', hasArgs: false },
  { phrases: ['આગળનું ટેબ'], action: 'next-tab', hasArgs: false },
  { phrases: ['પાછલું ટેબ'], action: 'prev-tab', hasArgs: false },
  { phrases: ['ટેબ બંધ કરો'], action: 'close-tab', hasArgs: false },
  { phrases: ['નવું ટેબ'], action: 'new-tab', hasArgs: false },
  { phrases: ['ફોકસ મોડ', 'ધ્યાન મોડ'], action: 'focus-mode', hasArgs: false },
  { phrases: ['વાંચન મોડ', 'રીડિંગ મોડ'], action: 'reading-mode', hasArgs: false },
  { phrases: ['પાનું વાંચો', 'વાંચીને સંભળાવો'], action: 'read-page', hasArgs: false },
  { phrases: ['સારાંશ આપો', 'સારાંશ'], action: 'summarize', hasArgs: false },
  { phrases: ['સરળ કરો', 'સહેલું કરો'], action: 'simplify', hasArgs: false },
  { phrases: ['ઈમેલ સારાંશ'], action: 'summarize-email', hasArgs: false },
  { phrases: ['ક્લિક કરો', 'દબાવો'], action: 'click', hasArgs: true },
  { phrases: ['ટાઇપ કરો', 'લખો'], action: 'type', hasArgs: true },
  { phrases: ['શોધો'], action: 'find', hasArgs: true },
  { phrases: ['સાંભળવાનું બંધ કરો', 'બંધ કરો'], action: 'stop-listening', hasArgs: false },
  { phrases: ['મદદ', 'હેલ્પ'], action: 'help', hasArgs: false },
];

// ---------------------------------------------------------------------------
// Malayalam (ml-IN)
// ---------------------------------------------------------------------------

const ML_COMMANDS: IndicCommandMapping[] = [
  { phrases: ['മുകളിലേക്ക് സ്ക്രോൾ', 'മുകളിൽ പോകൂ', 'മുകളിൽ'], action: 'scroll-up', hasArgs: false },
  { phrases: ['താഴേക്ക് സ്ക്രോൾ', 'താഴേക്ക് പോകൂ', 'താഴെ'], action: 'scroll-down', hasArgs: false },
  { phrases: ['ആരംഭത്തിലേക്ക് പോകൂ', 'മുകൾഭാഗത്തേക്ക്'], action: 'go-to-top', hasArgs: false },
  { phrases: ['അവസാനത്തിലേക്ക് പോകൂ', 'താഴെവരെ'], action: 'go-to-bottom', hasArgs: false },
  { phrases: ['പിന്നോട്ട് പോകൂ', 'തിരിച്ചു പോകൂ'], action: 'go-back', hasArgs: false },
  { phrases: ['മുന്നോട്ട് പോകൂ', 'മുന്നോട്ട്'], action: 'go-forward', hasArgs: false },
  { phrases: ['വീണ്ടും ലോഡ്', 'റീലോഡ്'], action: 'reload', hasArgs: false },
  { phrases: ['വലുതാക്കൂ', 'സൂം ഇൻ'], action: 'zoom-in', hasArgs: false },
  { phrases: ['ചെറുതാക്കൂ', 'സൂം ഔട്ട്'], action: 'zoom-out', hasArgs: false },
  { phrases: ['അടുത്ത ടാബ്'], action: 'next-tab', hasArgs: false },
  { phrases: ['മുമ്പത്തെ ടാബ്'], action: 'prev-tab', hasArgs: false },
  { phrases: ['ടാബ് അടയ്ക്കുക'], action: 'close-tab', hasArgs: false },
  { phrases: ['പുതിയ ടാബ്'], action: 'new-tab', hasArgs: false },
  { phrases: ['ഫോക്കസ് മോഡ്', 'ശ്രദ്ധ മോഡ്'], action: 'focus-mode', hasArgs: false },
  { phrases: ['വായന മോഡ്', 'റീഡിംഗ് മോഡ്'], action: 'reading-mode', hasArgs: false },
  { phrases: ['പേജ് വായിക്കുക', 'വായിച്ചു കേൾപ്പിക്കുക'], action: 'read-page', hasArgs: false },
  { phrases: ['സംഗ്രഹം നൽകുക', 'സംഗ്രഹം'], action: 'summarize', hasArgs: false },
  { phrases: ['ലളിതമാക്കുക', 'എളുപ്പമാക്കുക'], action: 'simplify', hasArgs: false },
  { phrases: ['ഇമെയിൽ സംഗ്രഹം'], action: 'summarize-email', hasArgs: false },
  { phrases: ['ക്ലിക്ക് ചെയ്യുക', 'അമർത്തുക'], action: 'click', hasArgs: true },
  { phrases: ['ടൈപ്പ് ചെയ്യുക', 'എഴുതുക'], action: 'type', hasArgs: true },
  { phrases: ['തിരയുക', 'കണ്ടെത്തുക'], action: 'find', hasArgs: true },
  { phrases: ['കേൾക്കുന്നത് നിർത്തുക', 'നിർത്തുക'], action: 'stop-listening', hasArgs: false },
  { phrases: ['സഹായം', 'ഹെൽപ്പ്'], action: 'help', hasArgs: false },
];

// ---------------------------------------------------------------------------
// Punjabi (pa-IN) — Gurmukhi script
// ---------------------------------------------------------------------------

const PA_COMMANDS: IndicCommandMapping[] = [
  { phrases: ['ਉੱਪਰ ਸਕ੍ਰੋਲ', 'ਉੱਪਰ ਜਾਓ', 'ਉੱਪਰ'], action: 'scroll-up', hasArgs: false },
  { phrases: ['ਹੇਠਾਂ ਸਕ੍ਰੋਲ', 'ਹੇਠਾਂ ਜਾਓ', 'ਹੇਠਾਂ'], action: 'scroll-down', hasArgs: false },
  { phrases: ['ਸ਼ੁਰੂ ਵਿੱਚ ਜਾਓ', 'ਸਭ ਤੋਂ ਉੱਪਰ'], action: 'go-to-top', hasArgs: false },
  { phrases: ['ਅੰਤ ਵਿੱਚ ਜਾਓ', 'ਸਭ ਤੋਂ ਹੇਠਾਂ'], action: 'go-to-bottom', hasArgs: false },
  { phrases: ['ਪਿੱਛੇ ਜਾਓ', 'ਵਾਪਸ ਜਾਓ'], action: 'go-back', hasArgs: false },
  { phrases: ['ਅੱਗੇ ਜਾਓ', 'ਅੱਗੇ'], action: 'go-forward', hasArgs: false },
  { phrases: ['ਦੁਬਾਰਾ ਲੋਡ', 'ਰੀਲੋਡ'], action: 'reload', hasArgs: false },
  { phrases: ['ਵੱਡਾ ਕਰੋ', 'ਜ਼ੂਮ ਇਨ'], action: 'zoom-in', hasArgs: false },
  { phrases: ['ਛੋਟਾ ਕਰੋ', 'ਜ਼ੂਮ ਆਉਟ'], action: 'zoom-out', hasArgs: false },
  { phrases: ['ਅਗਲਾ ਟੈਬ'], action: 'next-tab', hasArgs: false },
  { phrases: ['ਪਿਛਲਾ ਟੈਬ'], action: 'prev-tab', hasArgs: false },
  { phrases: ['ਟੈਬ ਬੰਦ ਕਰੋ'], action: 'close-tab', hasArgs: false },
  { phrases: ['ਨਵਾਂ ਟੈਬ'], action: 'new-tab', hasArgs: false },
  { phrases: ['ਫੋਕਸ ਮੋਡ', 'ਧਿਆਨ ਮੋਡ'], action: 'focus-mode', hasArgs: false },
  { phrases: ['ਪੜ੍ਹਨ ਦਾ ਮੋਡ', 'ਰੀਡਿੰਗ ਮੋਡ'], action: 'reading-mode', hasArgs: false },
  { phrases: ['ਪੰਨਾ ਪੜ੍ਹੋ', 'ਪੜ੍ਹ ਕੇ ਸੁਣਾਓ'], action: 'read-page', hasArgs: false },
  { phrases: ['ਸੰਖੇਪ ਦਿਓ', 'ਸੰਖੇਪ'], action: 'summarize', hasArgs: false },
  { phrases: ['ਸਰਲ ਕਰੋ', 'ਸੌਖਾ ਕਰੋ'], action: 'simplify', hasArgs: false },
  { phrases: ['ਈਮੇਲ ਸੰਖੇਪ'], action: 'summarize-email', hasArgs: false },
  { phrases: ['ਕਲਿੱਕ ਕਰੋ', 'ਦਬਾਓ'], action: 'click', hasArgs: true },
  { phrases: ['ਟਾਈਪ ਕਰੋ', 'ਲਿਖੋ'], action: 'type', hasArgs: true },
  { phrases: ['ਲੱਭੋ', 'ਖੋਜੋ'], action: 'find', hasArgs: true },
  { phrases: ['ਸੁਣਨਾ ਬੰਦ ਕਰੋ', 'ਬੰਦ ਕਰੋ'], action: 'stop-listening', hasArgs: false },
  { phrases: ['ਮਦਦ', 'ਹੈਲਪ'], action: 'help', hasArgs: false },
];

// ---------------------------------------------------------------------------
// Urdu (ur-IN) — Perso-Arabic script (RTL)
// ---------------------------------------------------------------------------

const UR_COMMANDS: IndicCommandMapping[] = [
  { phrases: ['اوپر اسکرول', 'اوپر جاؤ', 'اوپر'], action: 'scroll-up', hasArgs: false },
  { phrases: ['نیچے اسکرول', 'نیچے جاؤ', 'نیچے'], action: 'scroll-down', hasArgs: false },
  { phrases: ['شروع میں جاؤ', 'سب سے اوپر'], action: 'go-to-top', hasArgs: false },
  { phrases: ['آخر میں جاؤ', 'سب سے نیچے'], action: 'go-to-bottom', hasArgs: false },
  { phrases: ['پیچھے جاؤ', 'واپس جاؤ'], action: 'go-back', hasArgs: false },
  { phrases: ['آگے جاؤ', 'آگے'], action: 'go-forward', hasArgs: false },
  { phrases: ['دوبارہ لوڈ', 'ری لوڈ'], action: 'reload', hasArgs: false },
  { phrases: ['بڑا کرو', 'زوم ان'], action: 'zoom-in', hasArgs: false },
  { phrases: ['چھوٹا کرو', 'زوم آؤٹ'], action: 'zoom-out', hasArgs: false },
  { phrases: ['اگلا ٹیب'], action: 'next-tab', hasArgs: false },
  { phrases: ['پچھلا ٹیب'], action: 'prev-tab', hasArgs: false },
  { phrases: ['ٹیب بند کرو'], action: 'close-tab', hasArgs: false },
  { phrases: ['نیا ٹیب'], action: 'new-tab', hasArgs: false },
  { phrases: ['فوکس موڈ', 'توجہ موڈ'], action: 'focus-mode', hasArgs: false },
  { phrases: ['پڑھنے کا موڈ', 'ریڈنگ موڈ'], action: 'reading-mode', hasArgs: false },
  { phrases: ['صفحہ پڑھو', 'پڑھ کر سناؤ'], action: 'read-page', hasArgs: false },
  { phrases: ['خلاصہ دو', 'خلاصہ'], action: 'summarize', hasArgs: false },
  { phrases: ['آسان کرو', 'سادہ کرو'], action: 'simplify', hasArgs: false },
  { phrases: ['ای میل خلاصہ'], action: 'summarize-email', hasArgs: false },
  { phrases: ['کلک کرو', 'دباؤ'], action: 'click', hasArgs: true },
  { phrases: ['ٹائپ کرو', 'لکھو'], action: 'type', hasArgs: true },
  { phrases: ['ڈھونڈو', 'تلاش کرو'], action: 'find', hasArgs: true },
  { phrases: ['سننا بند کرو', 'بند کرو'], action: 'stop-listening', hasArgs: false },
  { phrases: ['مدد', 'ہیلپ'], action: 'help', hasArgs: false },
];

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const INDIC_COMMANDS: Record<IndicLangCode, IndicCommandMapping[]> = {
  'hi-IN': HI_COMMANDS,
  'ta-IN': TA_COMMANDS,
  'te-IN': TE_COMMANDS,
  'kn-IN': KN_COMMANDS,
  'bn-IN': BN_COMMANDS,
  'mr-IN': MR_COMMANDS,
  'gu-IN': GU_COMMANDS,
  'ml-IN': ML_COMMANDS,
  'pa-IN': PA_COMMANDS,
  'ur-IN': UR_COMMANDS,
};

// ---------------------------------------------------------------------------
// Matchers
// ---------------------------------------------------------------------------

/**
 * Locale-appropriate sentence terminators that should be tolerated when
 * matching exact phrases. Devanagari danda (।), double-danda (॥),
 * Urdu arabic full stop (۔), and plain ASCII '.' all qualify.
 */
const TERMINATORS: readonly string[] = ['', '।', '॥', '।।', '۔', '.', '|'];

/**
 * Try to match an Indic speech transcript against the commands registered
 * for the given language. Returns the action and trailing args, or null.
 */
export function matchIndicCommand(
  transcript: string,
  lang: IndicLangCode,
): MatchResult | null {
  const cleaned = transcript.trim();
  if (!cleaned) return null;

  const commands = INDIC_COMMANDS[lang];
  if (!commands) return null;

  for (const cmd of commands) {
    for (const phrase of cmd.phrases) {
      if (cmd.hasArgs) {
        if (
          cleaned.startsWith(phrase + ' ') ||
          cleaned.startsWith(phrase + '\u00A0')
        ) {
          const args = cleaned.slice(phrase.length).trim();
          return { action: cmd.action, args };
        }
      } else {
        for (const term of TERMINATORS) {
          if (cleaned === phrase + term) {
            return { action: cmd.action, args: '' };
          }
        }
      }
    }
  }

  return null;
}

/**
 * Try to match a transcript against ALL supported Indic languages.
 * Returns the first language whose commands match, or null. Useful when
 * the user's voice-recognition locale is unknown or set to English but
 * they speak in an Indian language.
 */
export function matchAnyIndicCommand(
  transcript: string,
): { lang: IndicLangCode; result: MatchResult } | null {
  for (const code of Object.keys(INDIC_COMMANDS) as IndicLangCode[]) {
    const result = matchIndicCommand(transcript, code);
    if (result) return { lang: code, result };
  }
  return null;
}
