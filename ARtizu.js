// ====== 設定値 ======
const THRESHOLD_DISTANCE = 5; // ピンを消す（次のピンを表示する）しきい値距離 (メートル)
const PIN_MODEL_SCALE = '0.5 0.5 0.5'; // ピンの3Dモデルのスケール
const PIN_HEIGHT_OFFSET = 1; // 地面からのピンの高さ調整 (メートル)
const UPDATE_INTERVAL_MS = 100; // ARピンの更新間隔 (ミリ秒)

// ====== グローバル変数 ======
let userLatitude = null;
let userLongitude = null;
let userHeading = 0; // ユーザーが向いている方位 (0:北, 90:東, 180:南, 270:西)

let currentDestinationPinIndex = -1; // 現在案内中のピンのインデックス
let pinsData = []; // 全てのピンのデータ（イベント選択時に設定）

const arPinsContainer = document.querySelector('#ar-pins-container');
const currentLocationSpan = document.querySelector('#current-location');
const destinationInfoSpan = document.querySelector('#destination-info');
const messagePanel = document.querySelector('#message');

let updateARPinsTimeout = null; // スロットリング用タイマー

// ====== ヘルパー関数 ======

/**
 * 2点間の距離をメートル単位で計算 (Haversine formula)
 * @param {object} p1 - {latitude, longitude}
 * @param {object} p2 - {latitude, longitude}
 * @returns {number} 距離 (メートル)
 */
function calculateDistance(p1, p2) {
    const R = 6371e3; // metres
    const φ1 = p1.latitude * Math.PI / 180; // φ, λ in radians
    const φ2 = p2.latitude * Math.PI / 180;
    const Δφ = (p2.latitude - p1.latitude) * Math.PI / 180;
    const Δλ = (p2.longitude - p1.longitude) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    const d = R * c; // in metres
    return d;
}

/**
 * ある地点から別の地点への方位を計算 (北を0度とし、時計回りに360度)
 * @param {object} p1 - {latitude, longitude}
 * @param {object} p2 - {latitude, longitude}
 * @returns {number} 方位 (度)
 */
function calculateBearing(p1, p2) {
    const φ1 = p1.latitude * Math.PI / 180;
    const λ1 = p1.longitude * Math.PI / 180;
    const φ2 = p2.latitude * Math.PI / 180;
    const λ2 = p2.longitude * Math.PI / 180;

    const y = Math.sin(λ2 - λ1) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) -
              Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);
    const bearing = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    return bearing;
}

/**
 * 緯度経度差をメートルに変換するヘルパー (現在の緯度に基づいて経度方向のスケールを調整)
 * @param {number} lat1 - ユーザーの緯度
 * @param {number} lon1 - ユーザーの経度
 * @param {number} lat2 - ピンの緯度
 * @param {number} lon2 - ピンの経度
 * @returns {object} {deltaX, deltaZ} X(東西)方向、Z(南北)方向のメートル差
 */
function latLonToMeters(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // 地球の半径 (メートル)

    // 緯度1度あたりのメートル
    const latToMeter = R * (Math.PI / 180);

    // 経度1度あたりのメートル (平均緯度で調整)
    const avgLatRad = ((lat1 + lat2) / 2) * Math.PI / 180;
    const lonToMeter = R * Math.cos(avgLatRad) * (Math.PI / 180);

    const deltaLatMeters = (lat2 - lat1) * latToMeter;
    const deltaLonMeters = (lon2 - lon1) * lonToMeter;

    // deltaXは東西方向、deltaZは南北方向
    // AR.jsのZ軸は奥が負なので、南北方向の差をZ軸にマッピング
    // AR.jsのX軸は右が正なので、東西方向の差をX軸にマッピング
    return {
        deltaX: deltaLonMeters,
        deltaZ: deltaLatMeters
    };
}


// ====== 位置情報・方位センサーの取得 ======

// GPS (Geolocation API)
function initGeolocation() {
    if (navigator.geolocation) {
        navigator.geolocation.watchPosition(
            (position) => {
                userLatitude = position.coords.latitude;
                userLongitude = position.coords.longitude;
                currentLocationSpan.textContent = `緯度: ${userLatitude.toFixed(6)}, 経度: ${userLongitude.toFixed(6)}`;
                scheduleARPinsUpdate(); // 位置が更新されたらARピンの更新をスケジュール
            },
            (error) => {
                console.error('Geolocation error:', error);
                switch(error.code) {
                    case error.PERMISSION_DENIED:
                        messagePanel.textContent = '位置情報の利用が許可されていません。ブラウザの設定で位置情報のアクセスを許可してください。';
                        break;
                    case error.POSITION_UNAVAILABLE:
                        messagePanel.textContent = '位置情報が利用できません。電波の良い場所へ移動するか、GPSがオンになっているか確認してください。';
                        break;
                    case error.TIMEOUT:
                        messagePanel.textContent = '位置情報の取得がタイムアウトしました。電波の良い場所へ移動するか、再度お試しください。';
                        break;
                    case error.UNKNOWN_ERROR:
                        messagePanel.textContent = '不明なエラーが発生しました。';
                        break;
                }
            },
            {
                enableHighAccuracy: true,
                maximumAge: 0,
                timeout: 10000 // タイムアウトを少し長く設定
            }
        );
    } else {
        messagePanel.textContent = 'お使いのブラウザは位置情報をサポートしていません。';
    }
}

// DeviceOrientation (方位センサー)
function initDeviceOrientation() {
    if (window.DeviceOrientationEvent) {
        // iOS 13+ での許可要求
        if (typeof DeviceOrientationEvent.requestPermission === 'function') {
            DeviceOrientationEvent.requestPermission()
                .then(permissionState => {
                    if (permissionState === 'granted') {
                        window.addEventListener('deviceorientationabsolute', handleDeviceOrientation, true);
                    } else {
                        messagePanel.textContent = '方位センサーの利用が許可されませんでした。AR体験が制限されます。';
                    }
                })
                .catch(console.error);
        } else {
            // その他のブラウザ (Android Chromeなど)
            window.addEventListener('deviceorientationabsolute', handleDeviceOrientation, true);
        }
    } else {
        messagePanel.textContent = 'お使いのデバイスは方位センサーをサポートしていません。方位に基づくピンの向きは利用できません。';
    }
}

function handleDeviceOrientation(event) {
    if (event.alpha !== null) {
        // alpha: Z軸周りの回転（方位）。北が0度、東が90度、南が180度、西が270度
        // AR.jsの座標系に合わせるため反転 (北を0度として時計回りが正、カメラのZ軸負方向が前方)
        // デバイスのセンサーによってalpha値の挙動が異なる場合があるため、テストしながら調整
        userHeading = 360 - event.alpha;
        // console.log("User Heading:", userHeading.toFixed(2));
        scheduleARPinsUpdate(); // 方位が更新されたらARピンの更新をスケジュール
    }
}

// ====== ARピンの表示ロジック ======

// スロットリング関数
function scheduleARPinsUpdate() {
    if (updateARPinsTimeout === null) {
        updateARPinsTimeout = setTimeout(() => {
            updateARPins();
            updateARPinsTimeout = null;
        }, UPDATE_INTERVAL_MS);
    }
}

function updateARPins() {
    if (userLatitude === null || userLongitude === null || pinsData.length === 0) {
        return; // 位置情報が未取得、またはピンデータがない場合は何もしない
    }

    // 現在案内中のピンの情報を取得
    const currentPin = pinsData[currentDestinationPinIndex];
    if (!currentPin) {
        messagePanel.textContent = '目的地に到着しました！';
        destinationInfoSpan.textContent = 'イベント会場';
        // 全てのピンを案内し終えたら、ARピンを削除
        const existingPin = document.querySelector('#current-ar-pin');
        if (existingPin) {
            existingPin.remove();
        }
        return;
    }

    destinationInfoSpan.textContent = currentPin.name;

    // ユーザーと現在のピンの距離と方位を計算
    const distance = calculateDistance(
        { latitude: userLatitude, longitude: userLongitude },
        { latitude: currentPin.latitude, longitude: currentPin.longitude }
    );
    const bearing = calculateBearing(
        { latitude: userLatitude, longitude: userLongitude },
        { latitude: currentPin.latitude, longitude: currentPin.longitude }
    );

    messagePanel.textContent = `残り距離: ${distance.toFixed(1)}m`;

    // しきい値距離より近づいたら次のピンへ
    if (distance < THRESHOLD_DISTANCE) {
        currentDestinationPinIndex++;
        updateARPins(); // 次のピンをすぐに表示
        return;
    }

    // AR空間におけるピンのXYZ座標を計算
    // 北を基準とした方位とユーザーの向きを考慮
    // AR.jsのカメラは通常Y軸が上方向
    
    // 緯度経度差からメートルへの変換
    const { deltaX, deltaZ } = latLonToMeters(
        userLatitude, userLongitude,
        currentPin.latitude, currentPin.longitude
    );

    // Three.js (A-Frame) のZ軸は奥方向が負、X軸は右方向が正
    // ユーザーの現在位置と向きに基づいて相対的な位置を計算
    // bearing: 目的地への方位 (北0, 時計回り)
    // userHeading: ユーザーの向いている方位 (北0, 時計回り)

    // ピンがユーザーから見て相対的にどの方向にあるかを角度で示す (ラジアン)
    // bearing - userHeading でユーザーの正面から見た相対角度を計算
    // Math.sinでX軸成分、Math.cosでZ軸成分を計算
    const angleFromUserToPinRad = (bearing - userHeading) * Math.PI / 180;

    // AR空間での相対座標
    // AR.jsのワールド座標系は、通常、カメラの初期位置が(0,0,0)で、カメラのZ軸が奥方向（負）
    // よって、目的地がカメラの「前方」にあるように計算
    const x = distance * Math.sin(angleFromUserToPinRad); // X軸方向 (右が正)
    const z = -distance * Math.cos(angleFromUserToPinRad); // Z軸方向 (奥が負)

    const y = PIN_HEIGHT_OFFSET; // 地面からの高さ

    // ARピンのエンティティを既存のもので更新、または新規作成
    let pinEntity = document.querySelector('#current-ar-pin');
    if (!pinEntity) {
        pinEntity = document.createElement('a-entity');
        pinEntity.setAttribute('id', 'current-ar-pin'); // 一意のIDを設定
        pinEntity.setAttribute('gltf-model', '#pin-model');
        pinEntity.setAttribute('scale', PIN_MODEL_SCALE);
        arPinsContainer.appendChild(pinEntity);
    }

    // 位置と回転を設定
    pinEntity.setAttribute('position', `${x} ${y} ${z}`);

    // ピンの向きをユーザーの方向に向ける（または進行方向に向ける）
    // gltfモデルのデフォルトの向きによって調整が必要
    // 例えば、モデルがZ軸負方向を正面としている場合、ユーザーから見てピンの正面をユーザーに向けるには
    // (bearing - userHeading) + 180 度回転させる必要がある場合が多い。
    // ここでは、ユーザーの正面に対してピンの正面が向くように調整を試みます。
    // -angleFromUserToPinRad は、ユーザーの向きから見てピンがある方向。
    // +180 はモデルの正面をユーザーに向けるための一般的なオフセット。
    pinEntity.setAttribute('rotation', `0 ${(-angleFromUserToPinRad * 180 / Math.PI) + 180} 0`);
}

// ====== 初期化 ======

document.addEventListener('DOMContentLoaded', () => {
    // URLのクエリパラメータからイベント情報を取得
    const params = new URLSearchParams(window.location.search);
    const eventId = params.get('event');

    if (eventId) {
        // ここで実際のイベントデータとピンの経路データを読み込む
        // 仮データ (実際にはサーバーから取得するなど)
        // 日本（八王子）近辺の座標に変更
        switch (eventId) {
            case 'bungaku':
                pinsData = [
                    { name: '中央大学多摩キャンパス正門', latitude: 35.617937, longitude: 139.423984 },
                    { name: '文学部棟入口', latitude: 35.618600, longitude: 139.425500 },
                    { name: '文学部イベント会場 (教室)', latitude: 35.619100, longitude: 139.426000 }
                ];
                break;
            case 'setsumeikai':
                pinsData = [
                    { name: 'Cスクエア入口', latitude: 35.617500, longitude: 139.423000 },
                    { name: '△△ホール会場', latitude: 35.617800, longitude: 139.423300 }
                ];
                break;
            // 他のイベントのピンデータもここに追加
            default:
                messagePanel.textContent = '指定されたイベントが見つかりません。';
                return;
        }
        currentDestinationPinIndex = 0; // 最初のピンから案内を開始
        destinationInfoSpan.textContent = pinsData[0].name;

        // A-Frameシーンが完全にロードされてから位置情報と方位センサーを初期化
        document.querySelector('a-scene').addEventListener('loaded', () => {
            console.log('A-Frame scene loaded. Initializing sensors...');
            initGeolocation();
            initDeviceOrientation();
            messagePanel.textContent = '位置情報を取得しています...';
        });

    } else {
        messagePanel.textContent = 'イベントが指定されていません。URLに ?event=bungaku または ?event=setsumeikai を追加してください。';
    }
});
